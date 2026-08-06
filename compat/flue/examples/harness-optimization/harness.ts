export type WorkspaceHarness = Readonly<{
  model: string;
  prompt: Readonly<{
    instructions: string;
    task: string;
  }>;
  tools: Readonly<
    Record<string, Readonly<{ description: string; enabled: boolean }>>
  >;
  mcpServers: Readonly<
    Record<string, Readonly<{ url: string; transport: "sse" | "streamable-http" }>>
  >;
  skills: Readonly<Record<string, Readonly<{ instructions: string }>>>;
  agents: Readonly<
    Record<string, Readonly<{ description: string; instructions: string }>>
  >;
  workspace: Readonly<{
    root: string;
    files: Readonly<Record<string, string>>;
  }>;
  sandbox: Readonly<{
    kind: "in-memory-bash";
    network: "disabled";
  }>;
  permissions: Readonly<{
    read: readonly string[];
    write: readonly string[];
    protected: readonly string[];
  }>;
  maxTurns: number;
}>;

export type WorkspaceCase = Readonly<{
  id: string;
  task: string;
  expectedFile: string;
  expectedContent: string;
}>;

export const WORKSPACE_GUIDE_COMPONENT =
  'harness.workspace.files["AGENTS.md"]' as const;

export const REQUIRED_WORKSPACE_RULE =
  "Do not modify TASK.md." as const;

export const OPTIMIZED_WORKSPACE_GUIDE = [
  REQUIRED_WORKSPACE_RULE,
  "Read TASK.md before acting.",
  "Use the bash tool to make the requested workspace change.",
  "Verify RESULT.txt before reporting completion.",
].join(" ");

export const seedHarness = {
  model: "agent-jsx-offline/workspace-model",
  prompt: {
    instructions: "Complete the requested task by following the workspace guidance.",
    task: "Complete TASK.md in the workspace.",
  },
  tools: {
    read: { description: "Read workspace files.", enabled: true },
    bash: { description: "Run code in the workspace sandbox.", enabled: true },
    task: { description: "Delegate to a configured subagent.", enabled: true },
  },
  mcpServers: {},
  skills: {},
  agents: {},
  workspace: {
    root: "/home/user",
    files: {
      "AGENTS.md": `${REQUIRED_WORKSPACE_RULE} Work carefully in this workspace.`,
    },
  },
  sandbox: {
    kind: "in-memory-bash",
    network: "disabled",
  },
  permissions: {
    read: ["AGENTS.md", "TASK.md", "RESULT.txt"],
    write: ["RESULT.txt"],
    protected: ["AGENTS.md", "TASK.md"],
  },
  maxTurns: 4,
} as const satisfies WorkspaceHarness;

export const workspaceCases = [
  {
    id: "alpha",
    task: "Create RESULT.txt containing exactly the requested alpha value.",
    expectedFile: "RESULT.txt",
    expectedContent: "alpha-ready\n",
  },
  {
    id: "beta",
    task: "Create RESULT.txt containing exactly the requested beta value.",
    expectedFile: "RESULT.txt",
    expectedContent: "beta-ready\n",
  },
] as const satisfies readonly WorkspaceCase[];

export function formatTaskFile(input: WorkspaceCase): string {
  return [
    input.task,
    `Target file: ${input.expectedFile}`,
    `Required UTF-8 content: ${JSON.stringify(input.expectedContent)}`,
  ].join("\n");
}

export function readHarnessComponent(
  harness: WorkspaceHarness,
  key: string,
): string | undefined {
  if (key === WORKSPACE_GUIDE_COMPONENT) {
    return harness.workspace.files["AGENTS.md"];
  }

  return undefined;
}

export function validateWorkspaceGuide(value: string): true | string {
  if (value.trim().length === 0) {
    return "workspace guidance must not be empty";
  }

  if (value.length > 1_000) {
    return "workspace guidance must be at most 1,000 characters";
  }

  if (!value.includes(REQUIRED_WORKSPACE_RULE)) {
    return `workspace guidance must preserve: ${REQUIRED_WORKSPACE_RULE}`;
  }

  return true;
}

export function applyHarnessCandidate(
  harness: WorkspaceHarness,
  candidate: Readonly<Record<string, string>>,
): WorkspaceHarness {
  const guide = candidate[WORKSPACE_GUIDE_COMPONENT];
  if (guide === undefined) {
    return harness;
  }

  const validation = validateWorkspaceGuide(guide);
  if (validation !== true) {
    throw new Error(
      `Invalid ${WORKSPACE_GUIDE_COMPONENT} candidate: ${validation}`,
    );
  }

  return {
    ...harness,
    workspace: {
      ...harness.workspace,
      files: {
        ...harness.workspace.files,
        "AGENTS.md": guide,
      },
    },
  };
}
