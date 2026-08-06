import { describe, expect, it } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { InMemoryFs } from "@flue/runtime/internal";
import { createFlueEvalHarness } from "../examples/harness-optimization/eval-harness.ts";
import {
  applyHarnessCandidate,
  OPTIMIZED_WORKSPACE_GUIDE,
  seedHarness,
  WORKSPACE_GUIDE_COMPONENT,
  workspaceCases,
} from "../examples/harness-optimization/harness.ts";
import {
  createHarnessBash,
  runFlueWorkspaceEpisode,
} from "../examples/harness-optimization/episode.ts";
import { optimizeFlueHarness } from "../examples/harness-optimization/optimizer.ts";

const report = await optimizeFlueHarness();

describe("Ax whole-harness optimization", () => {
  it("selects workspace guidance from external episode scores", () => {
    expect(report.baseline.meanScore).toBe(0);
    expect(report.baseline.outputs.every((output) => !output.success)).toBe(
      true,
    );
    expect(
      report.baseline.outputs.flatMap((output) => output.toolCalls),
    ).toEqual([]);

    expect(report.bestScore).toBe(1);
    expect(report.optimized.meanScore).toBe(1);
    expect(report.optimizationForwardCalls).toBe(0);
    expect(report.componentMap).toEqual({
      [WORKSPACE_GUIDE_COMPONENT]: OPTIMIZED_WORKSPACE_GUIDE,
    });
    expect(seedHarness.workspace.files["AGENTS.md"]).not.toBe(
      OPTIMIZED_WORKSPACE_GUIDE,
    );
  });

  it("rejects candidates that remove a frozen safety rule", () => {
    expect(() =>
      applyHarnessCandidate(seedHarness, {
        [WORKSPACE_GUIDE_COMPONENT]: "Use bash quickly.",
      }),
    ).toThrow("must preserve");
  });

  it("rejects evaluator cases that escape the workspace", async () => {
    await expect(
      runFlueWorkspaceEpisode(report.optimizedHarness, {
        ...workspaceCases[0],
        expectedFile: "../RESULT.txt",
      }),
    ).rejects.toThrow("relative and contained");
  });

  it("rejects non-empty contract maps the offline runner cannot mount", async () => {
    await expect(
      runFlueWorkspaceEpisode(
        {
          ...report.optimizedHarness,
          mcpServers: {
            docs: {
              url: "https://example.test/mcp",
              transport: "streamable-http",
            },
          },
        },
        workspaceCases[0],
      ),
    ).rejects.toThrow("harness.mcpServers to remain empty");
  });

  it("hard-rejects changes outside the frozen write policy", async () => {
    const output = await runFlueWorkspaceEpisode(
      {
        ...report.optimizedHarness,
        permissions: {
          ...report.optimizedHarness.permissions,
          write: [],
        },
      },
      workspaceCases[0],
    );

    expect(output.success).toBe(false);
    expect(output.violations).toContain(
      "write not allowed by harness: RESULT.txt",
    );
    expect(output.violations).toContain(
      "expected output is not writable: RESULT.txt",
    );
  });

  it("enforces the read allowlist beneath bash commands", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/home/user/SECRET.md", "not-for-the-agent\n");
    const bash = createHarnessBash(report.optimizedHarness, fs);

    await expect(bash.fs.readFile("/home/user/SECRET.md")).rejects.toThrow(
      "Read not allowed by harness: SECRET.md",
    );
    const result = await bash.exec("cat SECRET.md");

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("not-for-the-agent");
  });

  it("aborts an episode that exceeds maxTurns", async () => {
    const output = await runFlueWorkspaceEpisode(
      { ...report.optimizedHarness, maxTurns: 2 },
      workspaceCases[0],
    );

    expect(output.success).toBe(false);
    expect(
      output.violations.some((violation) =>
        violation.startsWith("turn budget exceeded:"),
      ),
    ).toBe(true);
  });
});

const optimizedEvalHarness = createFlueEvalHarness(report.optimizedHarness);

describeEval(
  "optimized Flue workspace harness",
  { harness: optimizedEvalHarness },
  (it) => {
    it.for(workspaceCases)("$id", async (input, { run }) => {
      const result = await run(input);

      expect(result.output.success).toBe(true);
      expect(result.output.actualContent).toBe(input.expectedContent);
      expect(result.output.changedFiles).toEqual([input.expectedFile]);
      expect(result.output.violations).toEqual([]);
      expect(toolCalls(result).map((call) => call.name)).toEqual([
        "read",
        "bash",
        "read",
      ]);
    });
  },
);
