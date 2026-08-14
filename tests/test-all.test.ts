import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFullGateSuites,
  formatCommand,
  formatDuration,
  formatSummary,
  runFullGate,
  type GateResult,
  type GateSuite,
} from "../scripts/test-all.ts";

describe("full repository gate", () => {
  const root = "/repo";
  const suites = createFullGateSuites(root);

  it("covers the package, examples, and every compatibility target from CI", () => {
    expect(suites.map((suite) => suite.name)).toEqual([
      "Package (unit + fixtures)",
      "Examples",
      "Compatibility / chess",
      "Compatibility / chess-goal",
      "Compatibility / cloudflare",
      "Compatibility / document-review",
      "Compatibility / parse-pm",
      "Compatibility / pdf-compiled",
      "Compatibility / think",
    ]);
    expect(suites[1]?.commands.map(formatCommand)).toEqual(["bun run all"]);
    expect(suites[1]?.isolation).toEqual({
      copyPaths: ["package.json", "tsconfig.json", "src", "examples", "fixtures"],
      comparePaths: ["examples/generated"],
    });
  });

  it("uses each compatibility package's frozen lockfile before its CI checks", () => {
    const commandsByTarget = new Map(
      suites.slice(2).map((suite) => [
        suite.name.replace("Compatibility / ", ""),
        suite.commands.map(formatCommand),
      ]),
    );

    expect(commandsByTarget).toEqual(
      new Map([
        ["chess", ["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]],
        ["chess-goal", ["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]],
        ["cloudflare", ["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]],
        ["document-review", ["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]],
        ["parse-pm", ["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]],
        ["pdf-compiled", ["bun install --frozen-lockfile", "bun run test"]],
        ["think", ["bun install --frozen-lockfile", "bun run typecheck", "bun run test"]],
      ]),
    );

    for (const suite of suites.slice(2)) {
      const target = suite.name.replace("Compatibility / ", "");
      expect(suite.cwd).toBe(join(root, "compat", target));
      expect(suite.timeoutMs).toBe(15 * 60 * 1_000);
    }
  });

  it("stays aligned with the compatibility matrix checked by GitHub Actions", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    const matrix = workflow.match(/matrix:\n\s+include:\n(?<entries>[\s\S]*?)\n\s+steps:/)?.groups?.entries;
    expect(matrix).toBeDefined();

    const workflowSuites = [...matrix!.matchAll(/- target:\s*(\S+)\n\s+command:\s*(.+)/g)]
      .map((match) => ({ target: match[1], command: match[2] }));
    const localSuites = suites.slice(2).map((suite) => ({
      target: suite.name.replace("Compatibility / ", ""),
      command: suite.commands.slice(1).map(formatCommand).join(" && "),
    }));

    expect(localSuites).toEqual(workflowSuites);
  });

  it("formats a stable summary with durations and aggregate counts", () => {
    const results: GateResult[] = [
      { name: "Package (unit + fixtures)", status: "PASS", durationMs: 1_250 },
      { name: "Compatibility / think", status: "FAIL", durationMs: 61_500 },
    ];

    const summary = formatSummary(results, 62_750);
    expect(summary).toContain("Suite");
    expect(summary).toContain("Package (unit + fixtures)  PASS");
    expect(summary).toMatch(/Compatibility \/ think\s+FAIL/);
    expect(summary).toContain("1.3s");
    expect(summary).toContain("1m 1.5s");
    expect(summary).toEndWith("1 passed, 1 failed in 1m 2.8s");
  });

  it("quotes display-only command arguments when needed", () => {
    expect(formatCommand({ args: ["run", "a command"] })).toBe('bun run "a command"');
    expect(formatDuration(250)).toBe("0.3s");
  });

  it("continues with independent suites after a failure and exits nonzero", async () => {
    const fakeSuites: GateSuite[] = [
      {
        name: "First",
        cwd: root,
        commands: [{ args: ["run", "fails"] }, { args: ["run", "must-not-run"] }],
        timeoutMs: 1_000,
      },
      { name: "Second", cwd: root, commands: [{ args: ["run", "passes"] }], timeoutMs: 1_000 },
    ];
    const executed: string[] = [];
    const output: string[] = [];
    let clock = 0;

    const exitCode = await runFullGate(fakeSuites, {
      execute: async (command) => {
        executed.push(formatCommand(command));
        return { exitCode: command.args.includes("fails") ? 2 : 0, signal: null };
      },
      log: (message) => output.push(message),
      error: (message) => output.push(message),
      now: () => (clock += 100),
    });

    expect(executed).toEqual(["bun run fails", "bun run passes"]);
    expect(exitCode).toBe(1);
    expect(output.join("\n")).toContain("First   FAIL");
    expect(output.join("\n")).toContain("Second  PASS");
  });

  it("stops cleanly when a child is interrupted", async () => {
    const fakeSuites: GateSuite[] = [
      { name: "Interrupted", cwd: root, commands: [{ args: ["run", "wait"] }], timeoutMs: 1_000 },
      { name: "Must not run", cwd: root, commands: [{ args: ["run", "later"] }], timeoutMs: 1_000 },
    ];
    const executed: string[] = [];

    const exitCode = await runFullGate(fakeSuites, {
      execute: async (command) => {
        executed.push(formatCommand(command));
        return { exitCode: 1, signal: "SIGINT" };
      },
      log: () => {},
      error: () => {},
      now: () => 0,
    });

    expect(executed).toEqual(["bun run wait"]);
    expect(exitCode).toBe(130);
  });

  it("detects generator drift in isolation without touching the source workspace", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-jsx-full-gate-"));
    const generatedDirectory = join(temporaryRoot, "examples", "generated");
    const generatedFile = join(generatedDirectory, "output.ts");
    mkdirSync(generatedDirectory, { recursive: true });
    mkdirSync(join(temporaryRoot, "node_modules"));
    writeFileSync(join(temporaryRoot, "package.json"), "{}\n");
    writeFileSync(generatedFile, "before\n");

    try {
      const exitCode = await runFullGate(
        [{
          name: "Examples",
          cwd: temporaryRoot,
          commands: [{ args: ["run", "all"] }],
          timeoutMs: 1_000,
          isolation: {
            copyPaths: ["package.json", "examples"],
            comparePaths: ["examples/generated"],
          },
        }],
        {
          execute: async (_command, isolatedRoot) => {
            writeFileSync(join(isolatedRoot, "examples", "generated", "output.ts"), "after\n");
            return { exitCode: 0, signal: null };
          },
          log: () => {},
          error: () => {},
          now: () => 0,
        },
      );

      expect(exitCode).toBe(1);
      expect(readFileSync(generatedFile, "utf8")).toBe("before\n");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("materializes generated-directory symlinks before running a generator", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-jsx-symlink-gate-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "agent-jsx-symlink-target-"));
    const externalFile = join(externalRoot, "output.ts");
    mkdirSync(join(temporaryRoot, "examples"), { recursive: true });
    mkdirSync(join(temporaryRoot, "node_modules"));
    writeFileSync(join(temporaryRoot, "package.json"), "{}\n");
    writeFileSync(externalFile, "outside\n");
    symlinkSync(externalRoot, join(temporaryRoot, "examples", "generated"), "dir");

    try {
      const exitCode = await runFullGate(
        [{
          name: "Examples",
          cwd: temporaryRoot,
          commands: [{ args: ["run", "all"] }],
          timeoutMs: 1_000,
          isolation: {
            copyPaths: ["package.json", "examples"],
            comparePaths: ["examples/generated"],
          },
        }],
        {
          execute: async (_command, isolatedRoot) => {
            writeFileSync(join(isolatedRoot, "examples", "generated", "output.ts"), "inside\n");
            return { exitCode: 0, signal: null };
          },
          log: () => {},
          error: () => {},
          now: () => 0,
        },
      );

      expect(exitCode).toBe(1);
      expect(readFileSync(externalFile, "utf8")).toBe("outside\n");
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("accepts a root node_modules symlink for the isolated example suite", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-jsx-linked-modules-gate-"));
    const externalModules = mkdtempSync(join(tmpdir(), "agent-jsx-modules-target-"));
    mkdirSync(join(temporaryRoot, "examples", "generated"), { recursive: true });
    writeFileSync(join(temporaryRoot, "package.json"), "{}\n");
    symlinkSync(externalModules, join(temporaryRoot, "node_modules"), "dir");

    try {
      const exitCode = await runFullGate(
        [{
          name: "Examples",
          cwd: temporaryRoot,
          commands: [{ args: ["run", "all"] }],
          timeoutMs: 1_000,
          isolation: {
            copyPaths: ["package.json", "examples"],
            comparePaths: ["examples/generated"],
          },
        }],
        {
          execute: async () => ({ exitCode: 0, signal: null }),
          log: () => {},
          error: () => {},
          now: () => 0,
        },
      );

      expect(exitCode).toBe(0);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
      rmSync(externalModules, { recursive: true, force: true });
    }
  });

  it("kills a nested command tree on SIGINT and leaves source output untouched", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-jsx-signal-gate-"));
    const generatedDirectory = join(temporaryRoot, "examples", "generated");
    const generatedFile = join(generatedDirectory, "output.ts");
    const runner = join(temporaryRoot, "signal-runner.ts");
    const worker = join(temporaryRoot, "worker.ts");
    const workerPidFile = join(temporaryRoot, "worker.pid");
    mkdirSync(generatedDirectory, { recursive: true });
    mkdirSync(join(temporaryRoot, "node_modules"));
    writeFileSync(join(temporaryRoot, "package.json"), JSON.stringify({ scripts: { all: "bun worker.ts" } }));
    writeFileSync(generatedFile, "before\n");
    writeFileSync(
      worker,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(process.env.TREE_PID_FILE!, String(process.pid));\n` +
        `writeFileSync("examples/generated/output.ts", "after\\n");\n` +
        `console.log("grandchild-ready");\n` +
        `process.on("SIGINT", () => console.log("grandchild-trapped-sigint"));\n` +
        `process.on("SIGTERM", () => console.log("grandchild-trapped-sigterm"));\n` +
        `await Bun.sleep(30_000);\n`,
    );
    writeFileSync(
      runner,
      `import { runFullGate } from ${JSON.stringify(new URL("../scripts/test-all.ts", import.meta.url).href)};\n` +
        `const root = process.argv[2]!;\n` +
        `process.exitCode = await runFullGate([{\n` +
        `  name: "Examples", cwd: root, timeoutMs: 60_000,\n` +
        `  commands: [{ args: ["run", "all"] }],\n` +
        `  isolation: { copyPaths: ["package.json", "worker.ts", "examples"], comparePaths: ["examples/generated"] },\n` +
        `}], { terminationGraceMs: 100 });\n`,
    );

    try {
      const child = spawn(process.execPath, [runner, temporaryRoot], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TREE_PID_FILE: workerPidFile },
      });
      let output = "";
      let sentSignal = false;
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sentSignal && output.includes("grandchild-ready")) {
          sentSignal = true;
          child.kill("SIGINT");
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`signal test timed out:\n${output}`));
        }, 10_000);
        child.once("error", reject);
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });

      expect(sentSignal).toBe(true);
      expect(result).toEqual({ code: 130, signal: null });
      expect(output).toContain("interrupted by SIGINT");
      expect(output).toContain("Full gate summary");
      expect(readFileSync(generatedFile, "utf8")).toBe("before\n");
      const workerPid = Number(readFileSync(workerPidFile, "utf8"));
      expect(() => process.kill(workerPid, 0)).toThrow();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("lets SIGINT take precedence while a timed-out command is shutting down", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-jsx-timeout-signal-gate-"));
    const runner = join(temporaryRoot, "timeout-signal-runner.ts");
    const worker = join(temporaryRoot, "timeout-worker.ts");
    const workerPidFile = join(temporaryRoot, "timeout-worker.pid");
    writeFileSync(join(temporaryRoot, "package.json"), JSON.stringify({ scripts: { all: "bun timeout-worker.ts" } }));
    writeFileSync(
      worker,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(process.env.TIMEOUT_WORKER_PID_FILE!, String(process.pid));\n` +
        `console.log("timeout-worker-ready");\n` +
        `process.on("SIGTERM", () => console.log("timeout-worker-trapped-sigterm"));\n` +
        `process.on("SIGINT", () => console.log("timeout-worker-trapped-sigint"));\n` +
        `await Bun.sleep(30_000);\n`,
    );
    writeFileSync(
      runner,
      `import { runFullGate } from ${JSON.stringify(new URL("../scripts/test-all.ts", import.meta.url).href)};\n` +
        `const root = process.argv[2]!;\n` +
        `process.exitCode = await runFullGate([{\n` +
        `  name: "Only", cwd: root, timeoutMs: 2_000,\n` +
        `  commands: [{ args: ["run", "all"] }],\n` +
        `}], { terminationGraceMs: 500 });\n`,
    );

    let workerPid: number | undefined;
    try {
      const child = spawn(process.execPath, [runner, temporaryRoot], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TIMEOUT_WORKER_PID_FILE: workerPidFile },
      });
      let output = "";
      let sentSignal = false;
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sentSignal && output.includes("timeout-worker-trapped-sigterm")) {
          sentSignal = true;
          child.kill("SIGINT");
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`timeout/signal test timed out:\n${output}`));
        }, 10_000);
        child.once("error", reject);
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });

      expect(sentSignal).toBe(true);
      expect(result).toEqual({ code: 130, signal: null });
      expect(output).toContain("Only interrupted by SIGINT");
      expect(output).toContain("timeout-worker-trapped-sigint");
      expect(output).toContain("Full gate summary");
      expect(output).not.toContain("Only failed at");
      workerPid = Number(readFileSync(workerPidFile, "utf8"));
      expect(() => process.kill(workerPid!, 0)).toThrow();
    } finally {
      if (workerPid === undefined && existsSync(workerPidFile)) {
        workerPid = Number(readFileSync(workerPidFile, "utf8"));
      }
      if (workerPid !== undefined) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {
          // The expected path already stopped the complete process tree.
        }
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
