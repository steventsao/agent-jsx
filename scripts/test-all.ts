import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export interface GateCommand {
  args: readonly string[];
}

export interface IsolatedSuite {
  /** Repository-relative inputs copied into a disposable workspace. */
  copyPaths: readonly string[];
  /** Paths compared before and after the suite to detect generator drift. */
  comparePaths: readonly string[];
}

export interface GateSuite {
  name: string;
  cwd: string;
  commands: readonly GateCommand[];
  timeoutMs: number;
  isolation?: IsolatedSuite;
}

export type GateStatus = "PASS" | "FAIL" | "INTERRUPTED";

export interface GateResult {
  name: string;
  status: GateStatus;
  durationMs: number;
  failedCommand?: string;
}

export interface CommandResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
}

export interface GateRunnerOptions {
  execute?: (command: GateCommand, cwd: string, timeoutMs: number) => Promise<CommandResult>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  now?: () => number;
  terminationGraceMs?: number;
}

interface ActiveCommand {
  interrupt: (signal: NodeJS.Signals) => void;
}

type SnapshotEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; contents: Buffer }
  | { path: string; kind: "symlink"; mode: number; target: string };

interface PathSnapshot {
  displayPath: string;
  existed: boolean;
  entries: SnapshotEntry[];
}

interface IsolatedWorkspace {
  cwd: string;
  snapshots: PathSnapshot[];
  cleanup: () => void;
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_TIMEOUT_MS = 10 * 60 * 1_000;
const COMPATIBILITY_TIMEOUT_MS = 15 * 60 * 1_000;

const compatibilitySuites = [
  { target: "chess", commands: [["run", "typecheck"], ["run", "test"]] },
  { target: "chess-goal", commands: [["run", "typecheck"], ["run", "test"]] },
  { target: "cloudflare", commands: [["run", "typecheck"], ["run", "test"]] },
  { target: "document-review", commands: [["run", "typecheck"], ["run", "test"]] },
  { target: "parse-pm", commands: [["run", "typecheck"], ["run", "test"]] },
  { target: "pdf-compiled", commands: [["run", "test"]] },
  { target: "think", commands: [["run", "typecheck"], ["run", "test"]] },
] as const;

/**
 * The local equivalent of the package and compatibility jobs in CI.
 * Compatibility packages intentionally keep independent lockfiles, so each
 * suite installs its exact dependency graph before running its checks.
 */
export function createFullGateSuites(root = repositoryRoot): GateSuite[] {
  return [
    {
      name: "Package (unit + fixtures)",
      cwd: root,
      commands: [{ args: ["run", "ci"] }],
      timeoutMs: PACKAGE_TIMEOUT_MS,
    },
    {
      name: "Examples",
      cwd: root,
      commands: [{ args: ["run", "all"] }],
      timeoutMs: PACKAGE_TIMEOUT_MS,
      isolation: {
        copyPaths: ["package.json", "tsconfig.json", "src", "examples", "fixtures"],
        comparePaths: ["examples/generated"],
      },
    },
    ...compatibilitySuites.map(({ target, commands }) => ({
      name: `Compatibility / ${target}`,
      cwd: join(root, "compat", target),
      commands: [
        { args: ["install", "--frozen-lockfile"] },
        ...commands.map((args) => ({ args })),
      ],
      timeoutMs: COMPATIBILITY_TIMEOUT_MS,
    })),
  ];
}

function quoteArgument(argument: string): string {
  return /^[\w@%+.,/:=-]+$/.test(argument) ? argument : JSON.stringify(argument);
}

export function formatCommand(command: GateCommand): string {
  return ["bun", ...command.args].map(quoteArgument).join(" ");
}

export function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

export function formatSummary(results: readonly GateResult[], totalDurationMs: number): string {
  const suiteWidth = Math.max("Suite".length, ...results.map((result) => result.name.length));
  const statusWidth = Math.max("Status".length, ...results.map((result) => result.status.length));
  const rows = [
    `${"Suite".padEnd(suiteWidth)}  ${"Status".padEnd(statusWidth)}  Duration`,
    `${"-".repeat(suiteWidth)}  ${"-".repeat(statusWidth)}  --------`,
    ...results.map(
      (result) =>
        `${result.name.padEnd(suiteWidth)}  ${result.status.padEnd(statusWidth)}  ${formatDuration(result.durationMs)}`,
    ),
  ];

  const passed = results.filter((result) => result.status === "PASS").length;
  const failed = results.filter((result) => result.status === "FAIL").length;
  const interrupted = results.filter((result) => result.status === "INTERRUPTED").length;
  const counts = [`${passed} passed`, `${failed} failed`];
  if (interrupted) counts.push(`${interrupted} interrupted`);

  return `${rows.join("\n")}\n\n${counts.join(", ")} in ${formatDuration(totalDurationMs)}`;
}

function runCommand(
  command: GateCommand,
  cwd: string,
  timeoutMs: number,
  terminationGraceMs: number,
  setActiveCommand: (command: ActiveCommand | null) => void,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, command.args, {
      cwd,
      env: process.env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timedOut = false;
    let terminationSignal: NodeJS.Signals | null = null;
    let childResult: CommandResult | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let treePollTimer: NodeJS.Timeout | undefined;
    let postKillTimer: NodeJS.Timeout | undefined;

    const signalTree = (signal: NodeJS.Signals, force = false) => {
      const pid = child.pid;
      if (pid === undefined) return;

      if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
        if ((result.error || result.status !== 0) && child.exitCode === null) {
          child.kill(force ? "SIGKILL" : signal);
        }
        return;
      }

      try {
        process.kill(-pid, force ? "SIGKILL" : signal);
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code !== "ESRCH" && child.exitCode === null) {
          child.kill(force ? "SIGKILL" : signal);
        }
      }
    };

    const treeIsAlive = (): boolean => {
      const pid = child.pid;
      if (pid === undefined) return false;
      if (process.platform === "win32") return child.exitCode === null;

      try {
        process.kill(-pid, 0);
        return true;
      } catch (checkError) {
        return (checkError as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (treePollTimer) clearInterval(treePollTimer);
      if (postKillTimer) clearTimeout(postKillTimer);
      setActiveCommand(null);
      resolve(result);
    };

    const finishInterruptedWhenStopped = () => {
      if (!terminationSignal || !childResult) return;
      if (treeIsAlive()) return;
      finish({ ...childResult, signal: terminationSignal, timedOut });
    };

    const forceStopTreeAfter = (delayMs: number) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (postKillTimer) {
        clearTimeout(postKillTimer);
        postKillTimer = undefined;
      }
      forceKillTimer = setTimeout(() => {
        signalTree("SIGKILL", true);
        postKillTimer = setTimeout(() => {
          if (childResult) finish({ ...childResult, signal: terminationSignal, timedOut });
        }, 5_000);
      }, delayMs);
    };

    const interrupt = (signal: NodeJS.Signals, fromTimeout = false) => {
      if (settled) return;
      if (fromTimeout) timedOut = true;
      if (terminationSignal) {
        if (!fromTimeout) {
          // A user's later Ctrl-C/Ctrl-Term must reach a tree already winding
          // down from a timeout. Give handlers one tick, then escalate instead
          // of making the user wait through the original grace period.
          terminationSignal = signal;
          signalTree(signal);
          if (process.platform !== "win32") forceStopTreeAfter(Math.min(100, terminationGraceMs));
        }
        return;
      }

      terminationSignal = signal;
      signalTree(signal);

      if (process.platform === "win32") return;
      treePollTimer = setInterval(finishInterruptedWhenStopped, 25);
      forceStopTreeAfter(terminationGraceMs);
    };

    setActiveCommand({ interrupt });
    const timeoutTimer = setTimeout(() => interrupt("SIGTERM", true), timeoutMs);

    child.once("error", (commandError) => {
      console.error(`Unable to start ${formatCommand(command)}: ${commandError.message}`);
      finish({ exitCode: 1, signal: null, timedOut });
    });
    child.once("exit", (exitCode, signal) => {
      childResult = { exitCode: exitCode ?? 1, signal, timedOut };
      if (!terminationSignal) {
        finish(childResult);
      } else if (process.platform === "win32") {
        finish({ ...childResult, signal: terminationSignal, timedOut });
      } else {
        finishInterruptedWhenStopped();
      }
    });
  });
}

function interruptedExitCode(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

function resolveInside(root: string, displayPath: string): string {
  if (isAbsolute(displayPath)) {
    throw new Error(`isolated path must be relative: ${displayPath}`);
  }

  const absolutePath = resolve(root, displayPath);
  const relativePath = relative(root, absolutePath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`isolated path escapes the workspace: ${displayPath}`);
  }
  return absolutePath;
}

function readSnapshotEntries(root: string, current = root): SnapshotEntry[] {
  const stats = lstatSync(current);
  const path = relative(root, current) || ".";
  const mode = stats.mode & 0o777;

  if (stats.isDirectory()) {
    return [
      { path, kind: "directory", mode },
      ...readdirSync(current)
        .sort((left, right) => left.localeCompare(right))
        .flatMap((entry) => readSnapshotEntries(root, join(current, entry))),
    ];
  }
  if (stats.isFile()) {
    return [{ path, kind: "file", mode, contents: readFileSync(current) }];
  }
  if (stats.isSymbolicLink()) {
    return [{ path, kind: "symlink", mode, target: readlinkSync(current) }];
  }
  throw new Error(`unsupported entry in generated output: ${path}`);
}

function capturePath(root: string, displayPath: string): PathSnapshot {
  const absolutePath = resolveInside(root, displayPath);
  return {
    displayPath,
    existed: existsSync(absolutePath),
    entries: existsSync(absolutePath) ? readSnapshotEntries(absolutePath) : [],
  };
}

function snapshotEntriesMatch(before: SnapshotEntry, after: SnapshotEntry): boolean {
  if (before.path !== after.path || before.kind !== after.kind || before.mode !== after.mode) return false;
  if (before.kind === "file" && after.kind === "file") return before.contents.equals(after.contents);
  if (before.kind === "symlink" && after.kind === "symlink") return before.target === after.target;
  return before.kind === "directory" && after.kind === "directory";
}

function snapshotsMatch(before: PathSnapshot, after: PathSnapshot): boolean {
  return before.existed === after.existed &&
    before.entries.length === after.entries.length &&
    before.entries.every((entry, index) => {
      const next = after.entries[index];
      return next ? snapshotEntriesMatch(entry, next) : false;
    });
}

function createIsolatedWorkspace(suite: GateSuite): IsolatedWorkspace {
  const isolation = suite.isolation;
  if (!isolation) throw new Error(`${suite.name} does not declare an isolated workspace`);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-jsx-full-gate-"));
  try {
    for (const displayPath of isolation.copyPaths) {
      const source = resolveInside(suite.cwd, displayPath);
      const destination = resolveInside(temporaryRoot, displayPath);
      if (!existsSync(source)) throw new Error(`isolated input does not exist: ${displayPath}`);
      mkdirSync(dirname(destination), { recursive: true });
      // Materialize symlink targets into the temporary tree. Preserving a link
      // could let a generator follow it back into the source workspace.
      cpSync(source, destination, { recursive: true, dereference: true, preserveTimestamps: true });
    }

    const nodeModules = join(suite.cwd, "node_modules");
    if (!existsSync(nodeModules) || !statSync(nodeModules).isDirectory()) {
      throw new Error("root node_modules is missing; run `bun install --frozen-lockfile` first");
    }
    symlinkSync(
      realpathSync(nodeModules),
      join(temporaryRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    return {
      cwd: temporaryRoot,
      snapshots: isolation.comparePaths.map((path) => capturePath(temporaryRoot, path)),
      cleanup: () => rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (isolationError) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw isolationError;
  }
}

export async function runFullGate(
  suites = createFullGateSuites(),
  options: GateRunnerOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const now = options.now ?? performance.now.bind(performance);
  const terminationGraceMs = options.terminationGraceMs ?? 5_000;
  const startedAt = now();
  const results: GateResult[] = [];
  const useDefaultExecutor = options.execute === undefined;
  let activeCommand: ActiveCommand | null = null;
  let requestedSignal: NodeJS.Signals | null = null;

  const requestSignal = (signal: NodeJS.Signals) => {
    requestedSignal ??= signal;
    activeCommand?.interrupt(signal);
  };
  const onSigint = () => requestSignal("SIGINT");
  const onSigterm = () => requestSignal("SIGTERM");

  if (useDefaultExecutor) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }

  const execute = options.execute ?? ((command: GateCommand, cwd: string, timeoutMs: number) =>
    runCommand(command, cwd, timeoutMs, terminationGraceMs, (commandController) => {
      activeCommand = commandController;
    }));

  try {
    for (const suite of suites) {
      log(`\n=== ${suite.name} ===`);
      const suiteStartedAt = now();
      const suiteDeadline = Date.now() + suite.timeoutMs;
      let status: GateStatus = requestedSignal ? "INTERRUPTED" : "PASS";
      let failedCommand: string | undefined;
      let signal: NodeJS.Signals | null = requestedSignal;
      let workspace: IsolatedWorkspace | undefined;
      let commandCwd = suite.cwd;

      try {
        if (status === "PASS" && suite.isolation) {
          try {
            workspace = createIsolatedWorkspace(suite);
            commandCwd = workspace.cwd;
          } catch (isolationError) {
            status = "FAIL";
            failedCommand = "prepare isolated workspace";
            error(`Unable to isolate ${suite.name}: ${String(isolationError)}`);
          }
        }

        for (const command of status === "PASS" ? suite.commands : []) {
          if (requestedSignal) {
            status = "INTERRUPTED";
            signal = requestedSignal;
            break;
          }

          const remainingMs = suiteDeadline - Date.now();
          if (remainingMs <= 0) {
            status = "FAIL";
            failedCommand = `suite timeout before ${formatCommand(command)}`;
            break;
          }

          log(`\n$ ${formatCommand(command)}`);
          const commandResult = await execute(command, commandCwd, remainingMs);
          if (requestedSignal) {
            signal = requestedSignal;
            status = "INTERRUPTED";
            failedCommand = formatCommand(command);
            break;
          }
          if (commandResult.timedOut) {
            status = "FAIL";
            failedCommand = `${formatCommand(command)} (timed out)`;
            break;
          }

          signal = commandResult.signal;
          if (signal) {
            status = "INTERRUPTED";
            failedCommand = formatCommand(command);
            break;
          }
          if (commandResult.exitCode !== 0) {
            status = "FAIL";
            failedCommand = formatCommand(command);
            break;
          }
        }

        if (workspace && status !== "INTERRUPTED") {
          const changedPaths: string[] = [];
          for (const before of workspace.snapshots) {
            try {
              const after = capturePath(workspace.cwd, before.displayPath);
              if (!snapshotsMatch(before, after)) changedPaths.push(before.displayPath);
            } catch (snapshotError) {
              status = "FAIL";
              failedCommand ??= "inspect isolated generated output";
              error(`Unable to inspect ${before.displayPath}: ${String(snapshotError)}`);
            }
          }
          if (changedPaths.length > 0) {
            if (status === "PASS") status = "FAIL";
            failedCommand ??= `generated output drift (${changedPaths.join(", ")})`;
            error(
              `Generated output changed in ${changedPaths.join(", ")} inside the disposable workspace. ` +
                "Run `bun run all` separately and review the generated changes.",
            );
          }
        }
      } finally {
        if (workspace) {
          try {
            workspace.cleanup();
          } catch (cleanupError) {
            if (status !== "INTERRUPTED") status = "FAIL";
            failedCommand ??= "remove isolated workspace";
            error(`Unable to remove the isolated ${suite.name} workspace: ${String(cleanupError)}`);
          }
        }
      }

      results.push({
        name: suite.name,
        status,
        durationMs: now() - suiteStartedAt,
        ...(failedCommand ? { failedCommand } : {}),
      });

      if (status === "FAIL") error(`\n${suite.name} failed at: ${failedCommand}`);
      if (status === "INTERRUPTED" && signal) {
        error(`\n${suite.name} interrupted by ${signal}.`);
        log(`\n=== Full gate summary ===\n\n${formatSummary(results, now() - startedAt)}`);
        return interruptedExitCode(signal);
      }
    }

    log(`\n=== Full gate summary ===\n\n${formatSummary(results, now() - startedAt)}`);
    return results.some((result) => result.status !== "PASS") ? 1 : 0;
  } finally {
    if (useDefaultExecutor) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  }
}

if (import.meta.main) {
  const packageManifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { packageManager: string };
  const expectedBun = packageManifest.packageManager.replace(/^bun@/, "");
  const actualBun = process.versions.bun;

  if (actualBun !== expectedBun) {
    console.error(
      `Full gate requires Bun ${expectedBun} (running ${actualBun ?? "an unknown version"}). ` +
        "Use the version pinned by packageManager, then retry `bun run test:all`.",
    );
    process.exitCode = 1;
  } else {
    console.log(`Full repository gate · Bun ${actualBun} · ${createFullGateSuites().length} suites`);
    process.exitCode = await runFullGate();
  }
}
