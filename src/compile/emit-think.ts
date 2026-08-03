/**
 * Compile target #1b: cloudflare/agents — THINK mode (model-driven delegation).
 *
 * The reconcile emitter (emit-cloudflare.ts) generates deterministic
 * `FiberAgentBase` classes: render → diff → apply, the runtime drives the work.
 * THINK mode generates `class X extends @cloudflare/think Think<Env>` instead:
 *
 *   - getSystemPrompt() = the component's <prompt> rendered over this.state (the
 *     context window), re-derived each model turn;
 *   - getTools() = the component's static <tool> records (→ an AI-SDK `tool`)
 *     PLUS every child boundary as `agentTool(ChildDurable, { description,
 *     inputSchema })`. A slot-bound child is NAMED BY THE PROP KEY; a plainly
 *     nested child is NAMED BY ITS KIND. The MODEL decides what to call;
 *   - one Think subclass per agent (a child is spawned per tool-call as a
 *     ctx.exports facet — the current agentTool semantics, see
 *     docs/agent-tools-investigation.md + docs/think-target.md).
 *
 * getModel() is emitted when the authored spec carries an explicit model. Older
 * low-level specs without one inherit Think's throwing default and can still be
 * overridden by a consumer or test. Compatibility is validated against
 * agents@0.20.1 + @cloudflare/think@0.15.1; the generated runTurnWithTrace
 * bridge retains Think's public text/reasoning
 * stream while binding the latest composition props for that turn. The proven
 * 0.8.x reconcile runtime is untouched. <sensor>/<schedule>/<task> have
 * no think-mode mapping (reconcile's job) → loud target diagnostics.
 */

import type {
  AnyAgentSpec,
  ResolvedAgentDefinition,
} from "../agent-component.tsx";
import {
  normalizeMcpServerId,
  resolveAgentSpecDefinition,
} from "../agent-definition.tsx";
import type { Analysis } from "./analyze.ts";
import type { ToolSlotBinding } from "./slots.ts";
import type { RootAgentSpec, ChildAgentSpec } from "./emit-cloudflare.ts";
import { emitRuntimeFiles } from "./runtime-files.ts";
import { evaluateComponent } from "./evaluate.ts";
import { collectInfra } from "../tree.ts";
import { createStore, withOutputs } from "../store.ts";
import {
  thinkTargetDiagnostics,
  formatTargetDiagnosticsForComment,
  type TargetDiagnostic,
} from "./target-diagnostics.ts";
import type { InfraRecord as SourceInfraRecord } from "../types.ts";

export interface ThinkEmitOptions {
  /** Rewrites the generated runtime imports off `../../src` (e.g. "./runtime"). */
  runtimeImport?: string;
  /** Absolute fs path; when set, the react-free runtime file set is copied here. */
  emitRuntimeTo?: string;
  /** Priompt token budget for getSystemPrompt. Default 400. */
  promptBudget?: number;
  /** Tool-slot bindings (src/compile/slots.ts): a binding whose provider is a
   *  generated agent becomes a getTools() agentTool NAMED BY THE PROP KEY. */
  toolSlots?: ToolSlotBinding[];
  /** Optional deployment-owned adapter for explicit authored model ids. This
   *  keeps provider credentials/packages out of agent source while avoiding
   *  provider inference in the compiler. The export receives (env, modelId)
   *  and returns either the id or an AI SDK LanguageModel. */
  modelResolver?: {
    importPath: string;
    exportName: string;
  };
  /** Optional deployment-owned MCP adapter. It receives
   * `(env, serverName, authoredDescriptor)` and may return public URL,
   * transport, OAuth callback, or config-revision settings. Direct headers are
   * rejected because Cloudflare Agents persists MCP transport options. */
  mcpResolver?: {
    importPath: string;
    exportName: string;
  };
  /** Aggregate wait for declared MCP connections. `true` uses Think's default. */
  mcpConnectionTimeoutMs?: number;
}

export interface ThinkEmit {
  agents: string;
  wrangler: string;
  /** Structured target-loss warnings also embedded beside generated classes. */
  diagnostics: TargetDiagnostic[];
}

/** A generated child plus its own multi-sample analysis. Supplying `analysis`
 * preserves state/prop-gated grandchildren and target diagnostics on the
 * intermediate Think class; callers without a graph may omit it and receive
 * the legacy representative-render fallback. */
export interface ThinkChildAgentSpec extends ChildAgentSpec {
  analysis?: Analysis;
}

const pascal = (s: string) => s.replace(/(?:^|[-_:])(\w)/g, (_, c) => c.toUpperCase());
const scream = (s: string) => s.replace(/[-:]/g, "_").toUpperCase();
/** A child KIND → a valid AI-SDK tool name (identifier-ish). */
const toolIdent = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
/** Emit an object key unquoted when it is a valid identifier, else quoted. */
const identKey = (s: string) =>
  s === "__proto__"
    ? `[${JSON.stringify(s)}]`
    : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)
      ? s
      : JSON.stringify(s);

/** Evaluate a spec's OWN render at sampleProps + initialState (expansion ON so a
 *  continuation-gated boundary/tool is still seen), collecting one kind of infra. */
function renderInfra(spec: AnyAgentSpec, sampleProps?: Record<string, unknown>) {
  const roots = withOutputs({ outputs: {}, setOutput: () => {}, expandSamples: true }, () =>
    evaluateComponent(spec.impl, {
      ...(sampleProps ?? spec.sampleProps ?? {}),
      store: createStore(spec.initialState),
      emit: () => {},
    } as never)
  );
  return roots.flatMap((root) => collectInfra(root));
}

/** Distinct subagent kinds a component's OWN render reveals, first-seen order. */
function childKindsOfSpec(child: ChildAgentSpec): string[] {
  const kinds: string[] = [];
  for (const rec of renderInfra(child.spec, child.sampleProps))
    if (rec.kind === "subagent") {
      const k = String(rec.config.kind);
      if (!kinds.includes(k)) kinds.push(k);
    }
  return kinds;
}

/** Distinct subagent kinds an analysis reveals — the root's direct children. */
function subagentKindsFromAnalysis(analysis: Analysis): string[] {
  const kinds: string[] = [];
  for (const r of [...analysis.static, ...analysis.dynamic])
    if (r.kind === "subagent") {
      const k = String(r.config.kind);
      if (!kinds.includes(k)) kinds.push(k);
    }
  return kinds;
}

/** Static <tool> records a component renders at rest: name + description. */
function staticToolsOfSpec(
  spec: AnyAgentSpec,
  sampleProps?: Record<string, unknown>,
): { name: string; description: string }[] {
  const tools: { name: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const rec of renderInfra(spec, sampleProps))
    if (rec.kind === "tool" && !seen.has(rec.name)) {
      seen.add(rec.name);
      tools.push({ name: rec.name, description: String(rec.config.description ?? "") });
    }
  return tools;
}

interface NodeInfo {
  isRoot: boolean;
  spec: AnyAgentSpec;
  exportName: string;
  importPath: string;
  className: string;
  binding: string;
  stateType: string;
  propsConst: string;
  definitionConst: string;
  sampleProps?: Record<string, unknown>;
  definition: ResolvedAgentDefinition;
  /** getTools agentTool entries: { toolName, childKind }. */
  entries: { toolName: string; childKind: string }[];
  tools: { name: string; description: string }[];
  diagnostics: TargetDiagnostic[];
}

export function emitThink(
  root: RootAgentSpec,
  children: ThinkChildAgentSpec[],
  analysis: Analysis,
  opts: ThinkEmitOptions = {}
): ThinkEmit {
  const rt = opts.runtimeImport ?? "../../src";
  const budget = opts.promptBudget ?? 400;
  const slots = opts.toolSlots ?? [];
  if (
    opts.mcpConnectionTimeoutMs !== undefined &&
    (!Number.isFinite(opts.mcpConnectionTimeoutMs) || opts.mcpConnectionTimeoutMs <= 0)
  ) {
    throw new Error("[agent-jsx] mcpConnectionTimeoutMs must be a positive number");
  }

  const rootClass = `${pascal(root.spec.agentName)}Durable`;
  const kids = children.map((c) => ({
    spec: c.spec,
    exportName: c.exportName,
    importPath: c.importPath,
    sampleProps: c.sampleProps,
    analysis: c.analysis,
    className: `${pascal(c.spec.agentName)}Durable`,
    binding: scream(c.spec.agentName),
  }));

  const classByKind = new Map<string, { className: string; exportName: string }>();
  classByKind.set(root.spec.agentName, { className: rootClass, exportName: root.componentName });
  for (const k of kids) classByKind.set(k.spec.agentName, { className: k.className, exportName: k.exportName });

  // agentTool entries for a node: slot-named (prop key) first — those override a
  // plain nesting of the same kind — then plain kinds named by kind.
  const entriesFor = (agentName: string, plainKinds: string[]) => {
    const entries: { toolName: string; childKind: string }[] = [];
    const slotKinds = new Set<string>();
    for (const b of slots)
      if (b.provider === agentName) {
        entries.push({ toolName: b.toolName, childKind: b.childKind });
        slotKinds.add(b.childKind);
      }
    for (const kind of plainKinds)
      if (!slotKinds.has(kind)) entries.push({ toolName: toolIdent(kind), childKind: kind });
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.toolName)) {
        throw new Error(
          `emitThink: duplicate child tool name "${entry.toolName}" on agent "${agentName}"`,
        );
      }
      seen.add(entry.toolName);
    }
    return entries;
  };

  const nodeFrom = (
    isRoot: boolean,
    spec: AnyAgentSpec,
    exportName: string,
    importPath: string,
    className: string,
    binding: string,
    plainKinds: string[],
    sampleProps?: Record<string, unknown>,
    analyzedRecords?: readonly SourceInfraRecord[],
  ): NodeInfo => {
    const definition = resolveAgentSpecDefinition(
      spec,
      sampleProps ?? spec.sampleProps ?? {},
    );
    const representativeProps = sampleProps ?? spec.sampleProps;
    return {
      isRoot,
      spec,
      exportName,
      importPath,
      className,
      binding,
      stateType: `${pascal(spec.agentName)}State`,
      propsConst: `${scream(spec.agentName)}_PROPS`,
      definitionConst: `${scream(spec.agentName)}_DEFINITION`,
      sampleProps: representativeProps,
      definition,
      entries: entriesFor(spec.agentName, plainKinds),
      tools: staticToolsOfSpec(spec, representativeProps),
      diagnostics: thinkTargetDiagnostics(
        spec,
        representativeProps,
        analyzedRecords,
      ),
    };
  };

  const nodes: NodeInfo[] = [
    nodeFrom(
      true,
      root.spec,
      root.componentName,
      root.componentImport,
      rootClass,
      scream(root.spec.agentName),
      subagentKindsFromAnalysis(analysis),
      root.spec.sampleProps,
      [...analysis.static, ...analysis.dynamic],
    ),
    ...kids.map((k) =>
      nodeFrom(
        false,
        k.spec,
        k.exportName,
        k.importPath,
        k.className,
        k.binding,
        k.analysis
          ? subagentKindsFromAnalysis(k.analysis)
          : childKindsOfSpec(k),
        k.sampleProps,
        k.analysis
          ? [...k.analysis.static, ...k.analysis.dynamic]
          : renderInfra(k.spec, k.sampleProps),
      )
    ),
  ];
  const diagnostics = nodes.flatMap((node) => node.diagnostics);

  // Class definitions may add/remove tools with state or turn props, so their
  // generated getTools() path must exist even when the representative render
  // has an empty map.
  const hasAnyTool = nodes.some(
    (n) => n.tools.length > 0 || Boolean(n.spec.resolveDefinition),
  );
  const hasAnyAgentTool = nodes.some((n) => n.entries.length > 0);
  const hasAnyGetTools = hasAnyTool || hasAnyAgentTool;
  const hasAnyModel = nodes.some((n) => Boolean(n.definition.model));
  const hasAnyMcp = nodes.some(
    (n) => Object.keys(n.definition.mcpServers).length > 0,
  );
  // A class definition still needs cleanup after its final MCP declaration is
  // removed on a later deploy. The compiler-owned table identifies only the
  // connections this lifecycle may remove.
  const hasAnyMcpLifecycle = nodes.length > 0;
  const hasAnySkills = nodes.some((n) => n.definition.skills.length > 0);

  // ── imports (conditional, so leaf/toolless emits stay minimal) ──
  const importLines = [`import { Think } from "@cloudflare/think";`];
  if (hasAnySkills)
    importLines.push(`import type { TurnContext } from "@cloudflare/think";`);
  if (hasAnyAgentTool) importLines.push(`import { agentTool } from "agents/agent-tools";`);
  if (hasAnyTool) importLines.push(`import { tool, jsonSchema } from "ai";`);
  else if (hasAnyAgentTool) importLines.push(`import { jsonSchema } from "ai";`);
  if (hasAnyGetTools) importLines.push(`import type { ToolSet } from "ai";`);
  if (hasAnyModel && opts.modelResolver)
    importLines.push(
      `import { ${opts.modelResolver.exportName} } from ${JSON.stringify(opts.modelResolver.importPath)};`,
    );
  if (hasAnyMcp && opts.mcpResolver)
    importLines.push(
      `import { ${opts.mcpResolver.exportName} } from ${JSON.stringify(opts.mcpResolver.importPath)};`,
    );
  importLines.push(`import { evaluateTree } from "${rt}/compile/evaluate.ts";`);
  importLines.push(
    hasAnyTool
      ? `import { collectInfra, collectPrompt } from "${rt}/tree.ts";`
      : `import { collectPrompt } from "${rt}/tree.ts";`
  );
  importLines.push(`import { renderPromptOrFallback } from "${rt}/prompt.ts";`);
  importLines.push(`import { createStore, withOutputs } from "${rt}/store.ts";`);
  importLines.push(`import type { AgentStore } from "${rt}/store.ts";`);
  if (hasAnyTool) importLines.push(`import type { InfraRecord } from "${rt}/types.ts";`);
  importLines.push(`import { ${root.componentName} } from "${root.componentImport}";`);
  for (const k of kids) importLines.push(`import { ${k.exportName} } from "${k.importPath}";`);

  const envEntries = nodes.map((n) => `  ${n.binding}: DurableObjectNamespace;`).join("\n");
  const modelEnvEntry = hasAnyModel ? "  AI: Ai;\n" : "";

  // ── shared Think base ──
  const toolRecordsMethod = hasAnyTool
    ? `
  /** This turn's declarative <tool> records with their freshest closures. */
  protected abstract renderedDefinition(): { tools: Readonly<Record<string, unknown>> };

  protected toolRecords(): InfraRecord[] {
    const out: InfraRecord[] = [];
    for (const r of this.renderRoots()) collectInfra(r as never, out);
    return out.filter((r) => r.kind === "tool");
  }
`
    : "";
  const toolByNameMethod = hasAnyTool
    ? `
  /** Preserve authored AI SDK tool objects by reference until Think asks for
   *  this turn's tools. No schema, approval, result, or provider metadata is
   *  flattened by the compiler. */
  protected localDefinitionTools(): ToolSet {
    return this.renderedDefinition().tools as ToolSet;
  }

  /** A declarative <tool> record → an AI SDK tool. Rich AI SDK tools should use
   *  the object-map form; JSX gets a permissive schema only when none is given. */
  protected declarativeTool(record: InfraRecord) {
    return tool({
      description: String(record.config.description ?? ""),
      inputSchema: modelToolInputSchema(
        record.config.inputSchema ?? jsonSchema<Record<string, unknown>>({ type: "object", properties: {}, additionalProperties: true }),
      ) as never,
      execute: async (input: Record<string, unknown>) => {
        const fresh = this.toolRecords().find((candidate) => candidate.name === record.name);
        return await fresh?.handlers.run?.(input);
      },
    });
  }

  protected declarativeTools(): ToolSet {
    return Object.fromEntries(
      this.toolRecords().map((record) => [record.name, this.declarativeTool(record)]),
    );
  }

  /** Tool-name collisions are authority bugs, not last-write-wins merges. */
  protected mergeToolSets(...sources: ToolSet[]): ToolSet {
    const entries: Array<[string, ToolSet[string]]> = [];
    const names = new Set<string>();
    for (const source of sources) {
      for (const [name, definition] of Object.entries(source)) {
        if (names.has(name)) throw new Error(\`duplicate model tool name: \${name}\`);
        names.add(name);
        entries.push([name, definition]);
      }
    }
    return Object.fromEntries(entries);
  }
`
    : "";

  const base = `const PROMPT_BUDGET = ${budget};

/** Shared Think base: getSystemPrompt renders the component's context window over
 *  this.state; a bound store makes <tool> run closures durable. No reconcile loop
 *  — the model drives tool calls (agentTool spawns a child facet per tool-call). */
abstract class ThinkAgentBase<S extends Record<string, unknown>> extends Think<GeneratedEnv> {
  protected abstract renderTree(): unknown;
  protected abstract imperativePrompt(state: S): string;

  /** Per-turn composition props. They remain transient: Think persists the
   *  transcript/state, while the caller supplies the latest boundary input. */
  #activeTurn?: { token: object; props?: Record<string, unknown> };
  #agentToolProps?: Record<string, unknown>;

  protected turnProps<T extends Record<string, unknown>>(fallback: T): T {
    const persisted = (this.state as { __agentToolProps?: Record<string, unknown> } | undefined)?.__agentToolProps;
    return {
      ...fallback,
      ...(persisted ?? {}),
      ...(this.#agentToolProps ?? {}),
      ...(this.#activeTurn?.props ?? {}),
    } as T;
  }

  /** agents@0.20 passes native agentTool input to Think as a child user message,
   *  not as render props. Capture the already schema-validated object here and
   *  persist it on the dedicated child facet so recovery and later prompt reads
   *  render the same declared agent definition. */
  protected override formatAgentToolInput(input: unknown) {
    const props = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    this.#agentToolProps = props;
    this.setState({ ...(this.state as S), __agentToolProps: props } as never);
    return super.formatAgentToolInput(input);
  }

  /** Generated programmatic-turn bridge. Think owns durable chat, persistence,
   *  recovery, and streaming; callers receive the public text plus any model-
   *  supplied reasoning stream for progress/thought UI. */
  async runTurnWithTrace(input: string, props?: Record<string, unknown>) {
    let requestId = "";
    let text = "";
    let reasoning = "";
    let failure = "";
    let interrupted = false;
    const turnToken = {};
    try {
      await this.chat(() => {
        // Bind props only after Think admits this queued turn. Token ownership
        // prevents one interleaved RPC from clearing a newer turn's context.
        this.#activeTurn = { token: turnToken, props };
        return [{
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text: input }],
        }];
      }, {
        onStart: (event) => { requestId = event.requestId; },
        onEvent: (json) => {
          const chunk = JSON.parse(json) as { type?: string; delta?: unknown; text?: unknown };
          const delta = typeof chunk.delta === "string"
            ? chunk.delta
            : typeof chunk.text === "string" ? chunk.text : "";
          switch (chunk.type) {
            case "text-delta": text += delta; break;
            case "reasoning-delta": reasoning += delta; break;
          }
        },
        onDone: () => {},
        onError: (error) => { failure = error; },
        onInterrupted: () => { interrupted = true; },
      });
    } finally {
      if (this.#activeTurn?.token === turnToken) this.#activeTurn = undefined;
    }
    if (failure) throw new Error(failure);
    if (interrupted) throw new Error("Think turn was interrupted before completion");
    return { requestId, text: text.trim(), reasoning: reasoning.trim() };
  }

  /** A store bridged to the DO: reads this.state, writes via setState (merge) —
   *  what makes a <tool> run closure's store.set(...) durable. */
  protected boundStore<T extends Record<string, unknown>>(): AgentStore<T> {
    return {
      get: () => this.state as unknown as T,
      set: (update) => {
        const prev = this.state as unknown as T;
        const next = typeof update === "function" ? (update as (p: T) => T)(prev) : { ...prev, ...update };
        this.setState(next as never);
      },
      subscribe: () => () => {},
      snapshot: () => JSON.stringify(this.state),
    };
  }

  /** Render this agent's tree with the continuation-outputs context bound to this
   *  DO's reserved __outputs slot (parity with reconcile mode's #renderRoots). */
  protected renderRoots(): unknown[] {
    const outputs = ((this.state as { __outputs?: Record<string, unknown> }) ?? {}).__outputs ?? {};
    return withOutputs({ outputs, setOutput: () => {} }, () => evaluateTree(this.renderTree()));
  }
${toolRecordsMethod}
  /** The authored prompt is re-derived from current state and turn props. A
   *  skill-bearing subclass composes it in beforeTurn because Think's Session
   *  context intentionally bypasses getSystemPrompt(). */
  protected authoredPrompt(): string {
    const blocks = collectPrompt(this.renderRoots() as never);
    return renderPromptOrFallback(blocks, PROMPT_BUDGET, () => this.imperativePrompt(this.state as S));
  }
${toolByNameMethod}}`;

  const mcpRuntimeHelpers = hasAnyMcpLifecycle
    ? `
type McpTransport = "auto" | "streamable-http" | "sse";
interface DesiredMcpServer {
  id: string;
  name: string;
  url: string;
  transport: McpTransport;
  callbackHost?: string;
  callbackPath?: string;
  configKey: string;
}

/** Normalize only public connection configuration. Cloudflare Agents persists
 * MCP transport options, so bearer headers are rejected instead of being
 * misleadingly treated as transient env-only credentials. */
function resolveMcpRuntimeConfig(
  name: string,
  authored: { url: string; transport?: McpTransport },
  resolution: unknown,
): Omit<DesiredMcpServer, "id" | "name"> {
  if (
    resolution !== undefined &&
    (!resolution || typeof resolution !== "object" || Array.isArray(resolution))
  ) {
    throw new Error('[agent-jsx] MCP server "' + name + '": mcpResolver must return an object or undefined');
  }
  const runtime = (resolution ?? {}) as Record<string, unknown>;
  if ("headers" in runtime) {
    throw new Error(
      '[agent-jsx] MCP server "' + name + '": direct headers are forbidden because Cloudflare Agents persists MCP transport headers; use OAuth callbacks or a credential-terminating proxy',
    );
  }
  const allowedFields = ["url", "transport", "callbackHost", "callbackPath", "configRevision"] as const;
  for (const field of Object.keys(runtime)) {
    if (!(allowedFields as readonly string[]).includes(field)) {
      throw new Error('[agent-jsx] MCP server "' + name + '": unsupported mcpResolver field "' + field + '"');
    }
  }
  for (const field of allowedFields) {
    if (runtime[field] !== undefined && typeof runtime[field] !== "string") {
      throw new Error('[agent-jsx] MCP server "' + name + '": mcpResolver.' + field + ' must be a string');
    }
  }
  let url: URL;
  try {
    url = new URL((runtime.url as string | undefined) ?? authored.url);
  } catch {
    throw new Error('[agent-jsx] MCP server "' + name + '": URL must be a valid HTTP or HTTPS URL');
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error('[agent-jsx] MCP server "' + name + '": URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('[agent-jsx] MCP server "' + name + '": URL must not contain credentials');
  }
  const sensitiveQueryParts = [
    "token",
    "apikey",
    "authorization",
    "clientsecret",
    "password",
    "passwd",
    "secret",
    "signature",
  ] as const;
  const isSensitiveQueryName = (name: string) => {
    const compact = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return (
      sensitiveQueryParts.some((part) => compact.includes(part)) ||
      compact === "auth" || compact.endsWith("auth") ||
      compact === "pwd" || compact.endsWith("pwd") ||
      compact === "sig" || compact.endsWith("sig")
    );
  };
  let credentialParameter = "";
  url.searchParams.forEach((_value, key) => {
    if (!credentialParameter && isSensitiveQueryName(key)) credentialParameter = key;
  });
  if (credentialParameter) {
    throw new Error('[agent-jsx] MCP server "' + name + '": URL contains sensitive MCP credential query parameter "' + credentialParameter + '"');
  }
  if (url.hash) {
    throw new Error('[agent-jsx] MCP server "' + name + '": URL must not contain a fragment');
  }
  const transport = (runtime.transport ?? authored.transport ?? "auto") as string;
  if (transport !== "auto" && transport !== "streamable-http" && transport !== "sse") {
    throw new Error('[agent-jsx] MCP server "' + name + '": unsupported transport "' + transport + '"');
  }
  const configRevision = ((runtime.configRevision as string | undefined) ?? "").trim();
  if (
    runtime.configRevision !== undefined &&
    (
      configRevision.length === 0 ||
      configRevision.length > 128 ||
      [...configRevision].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code > 0x7e;
      })
    )
  ) {
    throw new Error('[agent-jsx] MCP server "' + name + '": configRevision must contain 1-128 public characters');
  }
  let callbackHost: string | undefined;
  if (runtime.callbackHost !== undefined) {
    let callbackUrl: URL;
    try {
      callbackUrl = new URL(runtime.callbackHost as string);
    } catch {
      throw new Error('[agent-jsx] MCP server "' + name + '": callbackHost must be an HTTP(S) origin without credentials');
    }
    if (
      (callbackUrl.protocol !== "http:" && callbackUrl.protocol !== "https:") ||
      callbackUrl.username ||
      callbackUrl.password ||
      callbackUrl.pathname !== "/" ||
      callbackUrl.search ||
      callbackUrl.hash
    ) {
      throw new Error('[agent-jsx] MCP server "' + name + '": callbackHost must be an HTTP(S) origin without credentials');
    }
    callbackHost = callbackUrl.origin;
  }
  let callbackPath: string | undefined;
  if (runtime.callbackPath !== undefined) {
    const path = runtime.callbackPath as string;
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("?") ||
      path.includes("#") ||
      [...path].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
    ) {
      throw new Error('[agent-jsx] MCP server "' + name + '": callbackPath must be an absolute plain path without query or fragment');
    }
    callbackPath = path;
  }
  const normalizedUrl = url.toString();
  return {
    url: normalizedUrl,
    transport,
    ...(callbackHost !== undefined ? { callbackHost } : {}),
    ...(callbackPath !== undefined ? { callbackPath } : {}),
    configKey: JSON.stringify([
      1,
      name,
      normalizedUrl,
      transport,
      callbackHost ?? "",
      callbackPath ?? "",
      configRevision,
    ]),
  };
}
`
    : "";

  const modelToolInputSchemaHelper = hasAnyGetTools
    ? `
/** AI SDK v6 accepts its branded Schema, Standard Schema (including Zod), or a
 * schema factory. agent-jsx's target-neutral BoundarySchema intentionally also
 * accepts a throwing parse(value) validator, so adapt that public contract to
 * an AI SDK Schema without discarding its runtime validation. Plain JSON Schema
 * objects remain supported for declarative <tool> input. */
function modelToolInputSchema(schema: unknown): unknown {
  if (schema === undefined) return undefined;
  if (typeof schema === "function") return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("[agent-jsx] Think tool inputSchema must be an AI SDK/Standard Schema, a parse(value) validator, or JSON Schema");
  }
  const candidate = schema as Record<PropertyKey, unknown>;
  if (
    candidate[Symbol.for("vercel.ai.schema")] === true ||
    "~standard" in candidate
  ) return schema;
  const parse = candidate.parse;
  if (typeof parse === "function") {
    return jsonSchema<unknown>(
      { type: "object", properties: {}, additionalProperties: true },
      {
        validate: async (value) => {
          try {
            return { success: true as const, value: await parse.call(schema, value) };
          } catch (cause) {
            return {
              success: false as const,
              error: cause instanceof Error ? cause : new Error(String(cause)),
            };
          }
        },
      },
    );
  }
  return jsonSchema(schema as never);
}
`
    : "";

  // ── per-agent Think subclasses ──
  const emitClass = (n: NodeInfo): string => {
    const agentToolLines = n.entries.map((e) => {
        const child = classByKind.get(e.childKind);
        if (!child) throw new Error(`emitThink: no class registered for child kind "${e.childKind}"`);
        const childNode = nodes.find(
          (candidate) => candidate.spec.agentName === e.childKind,
        );
        const childDefinition = childNode?.definition;
        const description = childDefinition?.description ?? e.toolName;
        const contractExpr = childNode?.spec.resolveDefinition
          ? childNode.definitionConst
          : `${child.exportName}.spec`;
        const descriptionExpr = childNode?.spec.resolveDefinition
          ? `${contractExpr}.description ?? ${JSON.stringify(description)}`
          : `${child.exportName}.spec.description ?? ${JSON.stringify(e.toolName)}`;
        const displayNameExpr = childNode?.spec.resolveDefinition
          ? `${contractExpr}.displayName`
          : `${child.exportName}.spec.displayName`;
        return `      ${identKey(e.toolName)}: agentTool(${child.className}, { description: ${descriptionExpr}, displayName: ${displayNameExpr}, inputSchema: modelToolInputSchema(${contractExpr}.inputSchema), outputSchema: ${contractExpr}.outputSchema }),`;
      }).join("\n");
    const hasLocalToolPath = n.tools.length > 0 || Boolean(n.spec.resolveDefinition);
    const agentToolSet = n.entries.length
      ? `{
${agentToolLines}
    }`
      : "{}";
    const getToolsBlock = hasLocalToolPath
      ? `

  override getTools(): ToolSet {
    return this.mergeToolSets(
      this.localDefinitionTools(),
      this.declarativeTools(),
      ${agentToolSet},
    );
  }`
      : n.entries.length
        ? `

  override getTools(): ToolSet {
    return ${agentToolSet};
  }`
        : "";
    const initialState = n.isRoot
      ? `${JSON.stringify(n.spec.initialState)} as ${n.stateType}`
      : `{ ...${n.exportName}.spec.initialState } as ${n.stateType}`;
    const authoredModel = `${n.exportName}.spec.model ?? ${JSON.stringify(n.definition.model)}`;
    const resolvedModel = opts.modelResolver
      ? `${opts.modelResolver.exportName}(this.env, ${authoredModel})`
      : authoredModel;
    const modelBlock = n.definition.model
      ? `\n  override getModel() { return ${resolvedModel}; }`
      : `\n  // getModel() inherits Think's throwing default; consumers may override it.`;
    const renderedDefinitionBlock = hasAnyTool
      ? `
  protected renderedDefinition() {
    return ${n.spec.resolveDefinition
      ? `${n.exportName}.spec.resolveDefinition!(this.turnProps(${n.propsConst}) as never, this.boundStore<${n.stateType}>())`
      : `{ tools: {} }`};
  }
`
      : "";
    const skillsBlock = n.definition.skills.length
      ? `

  override getSkills() {
    return [...(${n.exportName}.spec.resolveDefinition?.(this.turnProps(${n.propsConst}) as never, this.boundStore<${n.stateType}>()).skills ?? ${n.exportName}.spec.skills ?? [])];
  }`
      : "";
    const promptBlock = n.definition.skills.length
      ? `

  /** Skills install a Session context block, which makes Think bypass
   * getSystemPrompt(). Compose the live authored prompt with Think's already
   * assembled context so both the skill catalog and fallback capability block
   * survive even if Session skill initialization degrades. */
  override async beforeTurn(ctx: TurnContext) {
    const authoredPrompt = this.authoredPrompt().trim();
    if (!authoredPrompt) return;
    const assembledPrompt = ctx.system.trim();
    return {
      instructions: assembledPrompt
        ? authoredPrompt + "\\n\\n" + assembledPrompt
        : authoredPrompt,
    };
  }`
      : `

  override getSystemPrompt(): string { return this.authoredPrompt(); }`;
    const mcpEntries = Object.entries(n.definition.mcpServers);
    const mcpWait = opts.mcpConnectionTimeoutMs === undefined
      ? "true"
      : `{ timeout: ${opts.mcpConnectionTimeoutMs} }`;
    const mcpDesired = mcpEntries
      .map(([name, server], index) => {
        const id = normalizeMcpServerId(name);
        const runtimeValue = opts.mcpResolver
          ? `await ${opts.mcpResolver.exportName}(this.env, ${JSON.stringify(name)}, ${JSON.stringify(server)})`
          : "undefined";
        return `    const runtime${index} = resolveMcpRuntimeConfig(
      ${JSON.stringify(name)},
      ${JSON.stringify(server)},
      ${runtimeValue},
    );
    desired.push({
      id: ${JSON.stringify(id)},
      name: ${JSON.stringify(name)},
      ...runtime${index},
    });`;
      })
      .join("\n");
    const hasMcpLifecycle = true;
    const mcpBlock = hasMcpLifecycle
      ? `
${mcpEntries.length ? `  waitForMcpConnections = ${mcpWait};\n` : ""}
  override async onStart() {
    this.sql\`
      CREATE TABLE IF NOT EXISTS agent_jsx_mcp_config (
        id TEXT PRIMARY KEY,
        config_key TEXT NOT NULL
      )
    \`;
    const configRows = this.sql<{ id: string; config_key: string }>\`
      SELECT id, config_key FROM agent_jsx_mcp_config
    \`;
    const recorded = new Map(configRows.map((row) => [row.id, row.config_key]));
    const desired: DesiredMcpServer[] = [];
${mcpDesired}
    const current = this.getMcpServers().servers;
    for (const [id, server] of Object.entries(current)) {
      const next = desired.find((candidate) => candidate.id === id);
      const recordedKey = recorded.get(id);
      if (
        (!next && recordedKey !== undefined) ||
        (next && (
          server.server_url !== next.url ||
          recordedKey !== next.configKey
        ))
      ) {
        await this.removeMcpServer(id);
      }
    }
    const retained = this.getMcpServers().servers;
    for (const server of desired) {
      if (
        retained[server.id]?.server_url === server.url &&
        recorded.get(server.id) === server.configKey
      ) continue;
      await this.addMcpServer(server.name, server.url, {
        id: server.id,
        ...(server.callbackHost !== undefined ? { callbackHost: server.callbackHost } : {}),
        ...(server.callbackPath !== undefined ? { callbackPath: server.callbackPath } : {}),
        transport: { type: server.transport },
      });
      this.sql\`
        INSERT INTO agent_jsx_mcp_config (id, config_key)
        VALUES (\${server.id}, \${server.configKey})
        ON CONFLICT(id) DO UPDATE SET config_key = excluded.config_key
      \`;
    }
    for (const id of recorded.keys()) {
      if (!desired.some((server) => server.id === id)) {
        this.sql\`DELETE FROM agent_jsx_mcp_config WHERE id = \${id}\`;
      }
    }
  }`
      : "";
    const diagComment = n.diagnostics.length
      ? `${formatTargetDiagnosticsForComment(n.diagnostics)}\n`
      : "";
    const structuredOutputBlock = n.definition.outputSchema
      ? `

  /** Native agentTool structured result: decode the child's final text but do
   *  not validate here. agents/agent-tools applies outputSchema exactly once at
   *  the parent boundary, including non-idempotent schema transforms. */
  protected override getAgentToolOutput(runId: string): unknown {
    const text = super.getAgentToolSummary(runId, undefined);
    if (text == null) return undefined;
    try { return JSON.parse(text); }
    catch { return text; }
  }`
      : "";
    return `// ---------------------------------------------------------------------------
// ${n.isRoot ? "Root" : "Child"} agent: ${n.spec.agentName}${n.isRoot ? "" : ` (from ${n.importPath})`}
type ${n.stateType} = typeof ${n.exportName}.spec.initialState & Record<string, unknown>;
const ${n.propsConst} = ${JSON.stringify(n.sampleProps ?? n.spec.sampleProps ?? {})} as const;
${n.spec.resolveDefinition
  ? `const ${n.definitionConst} = ${n.exportName}.spec.resolveDefinition!(${n.propsConst} as never, createStore(${n.exportName}.spec.initialState));\n`
  : ""}

${diagComment}export class ${n.className} extends ThinkAgentBase<${n.stateType}> {
  initialState = ${initialState};${modelBlock}${mcpBlock}
${renderedDefinitionBlock}
  protected renderTree(): unknown {
    return ${n.exportName}.spec.impl({ ...this.turnProps(${n.propsConst}), store: this.boundStore<${n.stateType}>(), emit: () => {} } as never);
  }
  protected imperativePrompt(state: ${n.stateType}): string {
    return ${n.exportName}.spec.getPrompt?.(state) ?? "";
  }${promptBlock}${structuredOutputBlock}${skillsBlock}${getToolsBlock}
}`;
  };

  const agents = `// GENERATED by agent-jsx (compile target: cloudflare/agents — THINK mode). Do not edit.
// You wrote: ${root.componentImport}${kids.map((k) => `, ${k.importPath}`).join("")}
// Derived Think glue: getSystemPrompt (the rendered context window), getTools
// (child boundaries -> agentTool, static <tool> -> tool). One Think subclass per
// agent; the MODEL drives delegation (no reconcile loop). See docs/think-target.md.

${importLines.join("\n")}

export interface GeneratedEnv extends Cloudflare.Env {
${modelEnvEntry}${envEntries}
}

${base}
${modelToolInputSchemaHelper}
${mcpRuntimeHelpers}

${nodes.map(emitClass).join("\n\n")}
`;

  const wrangler = `// GENERATED by agent-jsx (THINK mode) — merge into wrangler.jsonc
{
${hasAnyModel ? `  "ai": { "binding": "AI" },\n` : ""}  "durable_objects": {
    "bindings": [
${nodes.map((n) => `      { "name": "${n.binding}", "class_name": "${n.className}" }`).join(",\n")}
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [${nodes.map((n) => `"${n.className}"`).join(", ")}]
    }
  ]
}
`;

  if (opts.emitRuntimeTo) emitRuntimeFiles(opts.emitRuntimeTo);

  return { agents, wrangler, diagnostics };
}
