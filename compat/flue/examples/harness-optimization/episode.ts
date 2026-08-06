import {
  defineAgent,
  defineTool,
  observe,
  type FlueObservation,
  type PromptResponse,
} from "@flue/runtime";
import {
  Bash,
  InMemoryFs,
  bashFactoryToSessionEnv,
  createFlueContext,
} from "@flue/runtime/internal";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/compat";
import * as v from "valibot";
import {
  formatTaskFile,
  type WorkspaceCase,
  type WorkspaceHarness,
} from "./harness.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type EpisodeToolCall = {
  id: string;
  name: string;
  arguments: JsonValue;
  result: JsonValue;
  isError: boolean;
  durationMs: number;
  origin: string | null;
};

export type EpisodeOutcome = {
  caseId: string;
  success: boolean;
  score: number;
  response: string;
  expectedFile: string;
  expectedContent: string;
  actualContent: string | null;
  changedFiles: string[];
  violations: string[];
  toolCalls: EpisodeToolCall[];
  turns: number;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
  };
  model: string;
  error: string | null;
};

type WorkspaceSnapshot = Record<string, string>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? String(value)
      : (JSON.parse(serialized) as JsonValue);
  } catch {
    return String(value);
  }
}

function safeRelativePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Workspace paths must be relative and contained: ${path}`);
  }
  return normalized;
}

function workspacePath(root: string, relativePath: string): string {
  return `${root.replace(/\/$/, "")}/${safeRelativePath(relativePath)}`;
}

type BashFileSystem = NonNullable<
  NonNullable<ConstructorParameters<typeof Bash>[0]>["fs"]
>;

function relativeWorkspacePath(
  root: string,
  path: string,
  fs: InMemoryFs,
): string {
  const normalizedRoot = root.replace(/\/$/, "");
  const normalizedPath = path.replaceAll("\\", "/");
  const absolutePath = normalizedPath.startsWith("/")
    ? normalizedPath
    : `${normalizedRoot}/${normalizedPath}`;
  const resolved = fs.resolvePath(normalizedRoot, absolutePath);

  if (!resolved.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Workspace read escaped the harness root: ${path}`);
  }

  return safeRelativePath(resolved.slice(normalizedRoot.length + 1));
}

function createPermissionedBashFileSystem(
  harnessConfig: WorkspaceHarness,
  fs: InMemoryFs,
): BashFileSystem {
  const readable = new Set(
    harnessConfig.permissions.read.map((path) => safeRelativePath(path)),
  );
  const assertReadable = (path: string) => {
    const relativePath = relativeWorkspacePath(
      harnessConfig.workspace.root,
      path,
      fs,
    );
    if (!readable.has(relativePath)) {
      throw new Error(`Read not allowed by harness: ${relativePath}`);
    }
  };

  return new Proxy(fs, {
    get(target, property, receiver) {
      if (
        property === "readFile" ||
        property === "readFileBytes" ||
        property === "readFileBuffer" ||
        property === "readlink" ||
        property === "realpath"
      ) {
        return async (path: string, ...args: unknown[]) => {
          assertReadable(path);
          const method = Reflect.get(target, property, target) as (
            path: string,
            ...args: unknown[]
          ) => unknown;
          return await Reflect.apply(method, target, [path, ...args]);
        };
      }

      if (property === "cp" || property === "mv") {
        return async (source: string, ...args: unknown[]) => {
          assertReadable(source);
          const method = Reflect.get(target, property, target) as (
            source: string,
            ...args: unknown[]
          ) => unknown;
          return await Reflect.apply(method, target, [source, ...args]);
        };
      }

      if (property === "link" || property === "symlink") {
        return async () => {
          throw new Error(
            "Links are disabled because they can bypass harness file permissions",
          );
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as BashFileSystem;
}

export function createHarnessBash(
  harnessConfig: WorkspaceHarness,
  fs: InMemoryFs,
): Bash {
  return new Bash({
    fs: createPermissionedBashFileSystem(harnessConfig, fs),
    cwd: harnessConfig.workspace.root,
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function snapshotFileSystem(fs: InMemoryFs): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = {};

  for (const path of fs.getAllPaths().toSorted()) {
    const stat = await fs.stat(path);
    if (stat.isFile) {
      snapshot[path] = await fs.readFile(path);
    }
  }

  return snapshot;
}

function changedFiles(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .toSorted();
}

function toolResultText(
  message: Extract<
    Parameters<FauxResponseFactory>[0]["messages"][number],
    { role: "toolResult" }
  >,
): string {
  const raw = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // The tool may legitimately return text beginning with a quote.
    }
  }

  return raw;
}

function parseTaskFile(content: string): {
  targetFile: string;
  requiredContent: string;
} {
  const target = /^Target file: (.+)$/m.exec(content)?.[1];
  const required = /^Required UTF-8 content: (.+)$/m.exec(content)?.[1];
  if (!target || !required) {
    throw new Error("TASK.md is missing its target or required content");
  }

  const targetFile = safeRelativePath(target.trim());
  const requiredContent = JSON.parse(required) as unknown;
  if (typeof requiredContent !== "string") {
    throw new Error("TASK.md required content must be a JSON string");
  }

  return { targetFile, requiredContent };
}

function createScriptedTurn(): FauxResponseFactory {
  let selectedFile: string | undefined;
  let selectedContent: string | undefined;

  return (modelContext) => {
    const latest = modelContext.messages.at(-1);
    const systemPrompt = modelContext.systemPrompt ?? "";
    const optimizedGuideApplied = [
      "Read TASK.md before acting.",
      "Use the bash tool to make the requested workspace change.",
      "Verify RESULT.txt before reporting completion.",
    ].every((instruction) => systemPrompt.includes(instruction));

    if (latest?.role === "user") {
      if (!optimizedGuideApplied) {
        return fauxAssistantMessage(
          "The workspace guidance did not tell me to make the change.",
        );
      }

      return fauxAssistantMessage(
        fauxToolCall("read", { path: "TASK.md" }),
        { stopReason: "toolUse" },
      );
    }

    if (
      latest?.role === "toolResult" &&
      latest.toolName === "read" &&
      !modelContext.messages.some(
        (message) =>
          message.role === "toolResult" && message.toolName === "bash",
      )
    ) {
      const task = parseTaskFile(toolResultText(latest));
      selectedFile = task.targetFile;
      selectedContent = task.requiredContent;
      const command = [
        "printf %s",
        shellQuote(task.requiredContent),
        ">",
        shellQuote(task.targetFile),
      ].join(" ");

      return fauxAssistantMessage(fauxToolCall("bash", { command }), {
        stopReason: "toolUse",
      });
    }

    if (latest?.role === "toolResult" && latest.toolName === "bash") {
      if (!selectedFile) {
        throw new Error("The faux model did not derive a target from TASK.md");
      }
      return fauxAssistantMessage(
        fauxToolCall("read", { path: selectedFile }),
        { stopReason: "toolUse" },
      );
    }

    if (latest?.role === "toolResult" && latest.toolName === "read") {
      if (toolResultText(latest) !== selectedContent) {
        throw new Error("Workspace read-back did not match TASK.md");
      }
      return fauxAssistantMessage("Done.");
    }

    throw new Error(
      `Unexpected faux-model context: ${latest?.role ?? "empty"}`,
    );
  };
}

function assertSupportedHarness(harness: WorkspaceHarness): void {
  if (
    harness.sandbox.kind !== "in-memory-bash" ||
    harness.sandbox.network !== "disabled"
  ) {
    throw new Error(
      "This offline example requires the network-disabled in-memory sandbox",
    );
  }

  for (const [field, values] of [
    ["mcpServers", harness.mcpServers],
    ["skills", harness.skills],
    ["agents", harness.agents],
  ] as const) {
    if (Object.keys(values).length > 0) {
      throw new Error(
        `The offline example requires harness.${field} to remain empty`,
      );
    }
  }

  const supportedTools = new Set(["read", "bash", "task"]);
  for (const name of Object.keys(harness.tools)) {
    if (!supportedTools.has(name)) {
      throw new Error(`The offline example does not implement tool: ${name}`);
    }
  }
}

function modelParts(model: string): { provider: string; id: string } {
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`Harness model must use provider/model syntax: ${model}`);
  }

  return {
    provider: model.slice(0, separator),
    id: model.slice(separator + 1),
  };
}

export async function runFlueWorkspaceEpisode(
  harnessConfig: WorkspaceHarness,
  input: WorkspaceCase,
  externalSignal?: AbortSignal,
): Promise<EpisodeOutcome> {
  const startedAt = performance.now();
  assertSupportedHarness(harnessConfig);
  const expectedFile = safeRelativePath(input.expectedFile);
  if (expectedFile !== input.expectedFile) {
    throw new Error(
      `Case output path must already be normalized: ${input.expectedFile}`,
    );
  }

  const modelConfig = modelParts(harnessConfig.model);
  const fs = new InMemoryFs();
  for (const [path, content] of Object.entries(
    harnessConfig.workspace.files,
  )) {
    await fs.writeFile(
      workspacePath(harnessConfig.workspace.root, path),
      content,
    );
  }
  await fs.writeFile(
    workspacePath(harnessConfig.workspace.root, "TASK.md"),
    formatTaskFile(input),
  );
  const bashRuntime = createHarnessBash(harnessConfig, fs);

  const readTool = defineTool({
    name: "read",
    description:
      harnessConfig.tools.read?.description ?? "Read a workspace file.",
    input: v.object({ path: v.string() }),
    async run({ input: toolInput }) {
      const path = safeRelativePath(toolInput.path);
      if (!harnessConfig.permissions.read.includes(path)) {
        throw new Error(`Read not allowed by harness: ${path}`);
      }
      return fs.readFile(workspacePath(harnessConfig.workspace.root, path));
    },
  });
  const bashTool = defineTool({
    name: "bash",
    description:
      harnessConfig.tools.bash?.description ??
      "Run a command in the workspace sandbox.",
    input: v.object({ command: v.string() }),
    async run({ input: toolInput, signal: toolSignal }) {
      const result = await bashRuntime.exec(toolInput.command, {
        signal: toolSignal,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  });
  const agentTools = [
    ...(harnessConfig.tools.read?.enabled ? [readTool] : []),
    ...(harnessConfig.tools.bash?.enabled ? [bashTool] : []),
  ];
  const sandbox = {
    createSessionEnv: () => bashFactoryToSessionEnv(() => bashRuntime),
    // Supplying a factory replaces Flue's default filesystem tools. The named
    // custom tools above are therefore the only workspace capabilities.
    tools: () => [],
  };

  const budget = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, budget.signal])
    : budget.signal;
  const allowedTools = new Set(
    Object.entries(harnessConfig.tools)
      .filter(([, tool]) => tool.enabled)
      .map(([name]) => name),
  );
  const starts = new Map<
    string,
    Pick<EpisodeToolCall, "id" | "name" | "arguments" | "origin">
  >();
  const toolCalls: EpisodeToolCall[] = [];
  const violations: string[] = [];
  let turns = 0;
  let context: ReturnType<typeof createFlueContext> | undefined;
  let stopObserving: (() => void) | undefined;
  let runtimeHarness:
    | Awaited<
        ReturnType<ReturnType<typeof createFlueContext>["initializeRootHarness"]>
      >
    | undefined;
  let before: WorkspaceSnapshot = {};
  let after: WorkspaceSnapshot = {};
  let response: PromptResponse | undefined;
  let episodeError: string | null = null;

  const faux = registerFauxProvider({
    api: `agent-jsx-offline-${crypto.randomUUID()}`,
    provider: modelConfig.provider,
    models: [{ id: modelConfig.id }],
    tokensPerSecond: 100_000,
  });

  try {
    const model = faux.getModel();
    const scriptedTurn = createScriptedTurn();
    faux.setResponses([
      scriptedTurn,
      scriptedTurn,
      scriptedTurn,
      scriptedTurn,
    ]);

    context = createFlueContext({
      id: `episode-${crypto.randomUUID()}`,
      env: {},
      agentConfig: {
        resolveModel: (requested) =>
          requested === harnessConfig.model ? model : undefined,
      },
      createDefaultEnv: () => bashFactoryToSessionEnv(() => bashRuntime),
    });
    const scopedContext = context;
    stopObserving = observe(
      (event: FlueObservation, observedContext) => {
        if (observedContext !== scopedContext) {
          return;
        }

        if (event.type === "turn_start") {
          turns += 1;
          if (turns > harnessConfig.maxTurns) {
            violations.push(
              `turn budget exceeded: ${turns}/${harnessConfig.maxTurns}`,
            );
            budget.abort("Flue episode turn budget exceeded");
          }
          return;
        }

        if (event.type === "tool_start") {
          if (!allowedTools.has(event.toolName)) {
            violations.push(`tool not allowed by harness: ${event.toolName}`);
            budget.abort(`Tool not allowed: ${event.toolName}`);
          }

          starts.set(event.toolCallId, {
            id: event.toolCallId,
            name: event.toolName,
            arguments: toJsonValue(event.args),
            origin: event.origin ?? null,
          });
          return;
        }

        if (event.type === "tool") {
          const start = starts.get(event.toolCallId) ?? {
            id: event.toolCallId,
            name: event.toolName,
            arguments: null,
            origin: null,
          };
          toolCalls.push({
            ...start,
            result: toJsonValue(event.effectiveResult ?? event.result),
            isError: event.isError,
            durationMs: event.durationMs,
          });
        }
      },
    );

    const agent = defineAgent(() => ({
      model: harnessConfig.model,
      instructions: harnessConfig.prompt.instructions,
      cwd: harnessConfig.workspace.root,
      sandbox,
      tools: agentTools,
    }));
    runtimeHarness = await context.initializeRootHarness(agent);
    before = await snapshotFileSystem(fs);
    response = await (await runtimeHarness.session()).prompt(
      harnessConfig.prompt.task,
      { signal },
    );
    await context.flushEventCallbacks();
    after = await snapshotFileSystem(fs);
  } catch (error) {
    episodeError = errorMessage(error);
    try {
      await context?.flushEventCallbacks();
      after = await snapshotFileSystem(fs);
    } catch (snapshotError) {
      episodeError = `${episodeError}; snapshot failed: ${errorMessage(snapshotError)}`;
    }
  } finally {
    stopObserving?.();
    if (runtimeHarness) {
      try {
        await runtimeHarness.close();
      } catch (closeError) {
        episodeError = episodeError
          ? `${episodeError}; close failed: ${errorMessage(closeError)}`
          : `close failed: ${errorMessage(closeError)}`;
      }
    }
    faux.unregister();
  }

  const workspacePrefix = `${harnessConfig.workspace.root.replace(/\/$/, "")}/`;
  const changedAbsolutePaths = changedFiles(before, after);
  const outsideChanges = changedAbsolutePaths.filter(
    (path) => !path.startsWith(workspacePrefix),
  );
  const changed = changedAbsolutePaths
    .map((path) =>
      path.startsWith(workspacePrefix) ? path.slice(workspacePrefix.length) : path,
    )
    .toSorted();
  for (const path of outsideChanges) {
    violations.push(`write escaped workspace root: ${path}`);
  }
  const protectedChanges = changed.filter((path) =>
    harnessConfig.permissions.protected.includes(path),
  );
  const disallowedChanges = changed.filter(
    (path) => !harnessConfig.permissions.write.includes(path),
  );

  for (const path of protectedChanges) {
    violations.push(`protected file changed: ${path}`);
  }
  for (const path of disallowedChanges) {
    if (!protectedChanges.includes(path)) {
      violations.push(`write not allowed by harness: ${path}`);
    }
  }

  if (!harnessConfig.permissions.write.includes(input.expectedFile)) {
    violations.push(`expected output is not writable: ${input.expectedFile}`);
  }

  const actualContent =
    after[workspacePath(harnessConfig.workspace.root, expectedFile)] ?? null;
  const success =
    episodeError === null &&
    violations.length === 0 &&
    actualContent === input.expectedContent;
  const usage = response?.usage;

  return {
    caseId: input.id,
    success,
    score: success ? 1 : 0,
    response: response?.text ?? "",
    expectedFile: input.expectedFile,
    expectedContent: input.expectedContent,
    actualContent,
    changedFiles: changed,
    violations,
    toolCalls,
    turns,
    durationMs: performance.now() - startedAt,
    usage: {
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      cost: usage?.cost.total ?? 0,
    },
    model: harnessConfig.model,
    error: episodeError,
  };
}
