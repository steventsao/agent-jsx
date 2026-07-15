import { createStore, withOutputs } from "../store.ts";
import { collectInfra } from "../tree.ts";
import { evaluateComponent } from "./evaluate.ts";
import type { AnyAgentSpec } from "../agent-component.tsx";
import type { ChildAgentSpec } from "./emit-cloudflare.ts";

export type TargetDiagnosticSeverity = "warning" | "error";

export interface TargetDiagnostic {
  target: "flue" | "think";
  severity: TargetDiagnosticSeverity;
  code: string;
  message: string;
}

const formatInfra = (child: ChildAgentSpec) => {
  const roots = evaluateComponent(child.spec.impl, {
    ...(child.sampleProps ?? child.spec.sampleProps ?? {}),
    store: createStore(child.spec.initialState),
  } as never);
  return roots
    .flatMap((root) => collectInfra(root))
    // Subagent boundaries ARE emitted for flue now (native `subagents:` on the
    // profile); this warning is only about tools/schedules/sensors/tasks, which
    // a task profile cannot carry.
    .filter((r) => r.kind !== "subagent")
    .map((r) => `${r.kind}:${r.name}`);
};

/**
 * flue child profiles are task delegation targets, not stateful mounted child
 * runtimes. Keep that limitation explicit so a component author does not infer
 * Cloudflare-style child AgentStore semantics from a successful flue compile.
 */
export function flueChildTargetDiagnostics(child: ChildAgentSpec): TargetDiagnostic[] {
  const diagnostics: TargetDiagnostic[] = [];
  const stateKeys = Object.keys(child.spec.initialState ?? {});

  if (stateKeys.length > 0) {
    diagnostics.push({
      target: "flue",
      severity: "warning",
      code: "flue-child-state-not-durable",
      message:
        `child initialState keys [${stateKeys.join(", ")}] are used only to render ` +
        "the flue profile instructions; the flue task-profile target does not persist a child AgentStore.",
    });
  }

  try {
    const infra = formatInfra(child);
    if (infra.length > 0) {
      diagnostics.push({
        target: "flue",
        severity: "warning",
        code: "flue-child-infra-not-emitted",
        message:
          `child infra [${infra.join(", ")}] is not emitted into defineAgentProfile; ` +
          "the flue target exposes this child as a session.task profile.",
      });
    }
  } catch (error) {
    diagnostics.push({
      target: "flue",
      severity: "warning",
      code: "flue-child-analysis-failed",
      message:
        "could not statically inspect the child component for flue target limitations: " +
        (error instanceof Error ? error.message : String(error)),
    });
  }

  return diagnostics;
}

/**
 * THINK-mode diagnostics. A `Think` agent is a model-driven chat turn — it has
 * getSystemPrompt (the context window) + getTools (child boundaries + <tool>
 * records) and NO deterministic reconcile loop. So the reconcile-only infra
 * kinds (<sensor> poll convergence, <schedule> cron rows, <task> run-once) have
 * no think-mode mapping and are DROPPED with a loud warning — the author should
 * use reconcile mode (emitCloudflare) for durable-infra convergence, or wire the
 * schedule by hand on the Think subclass (Think extends Agent, so this.schedule
 * exists, but the emitter does not converge it). One diagnostic per unsupported
 * KIND present in the component's own render.
 */
const THINK_UNSUPPORTED: Record<string, string> = {
  sensor: "think-sensor-unsupported",
  schedule: "think-schedule-unsupported",
  task: "think-task-unsupported",
};

export function thinkTargetDiagnostics(spec: AnyAgentSpec): TargetDiagnostic[] {
  const byKind = new Map<string, string[]>();
  try {
    // Sample-output expansion ON so a continuation-gated <task>/<tool> is seen too.
    const roots = withOutputs({ outputs: {}, setOutput: () => {}, expandSamples: true }, () =>
      evaluateComponent(spec.impl, {
        ...(spec.sampleProps ?? {}),
        store: createStore(spec.initialState),
        emit: () => {},
      } as never)
    );
    for (const root of roots)
      for (const rec of collectInfra(root)) {
        if (!(rec.kind in THINK_UNSUPPORTED)) continue;
        const list = byKind.get(rec.kind) ?? [];
        list.push(rec.name);
        byKind.set(rec.kind, list);
      }
  } catch {
    return [
      {
        target: "think",
        severity: "warning",
        code: "think-analysis-failed",
        message: "could not statically inspect the component for think-mode limitations.",
      },
    ];
  }

  return [...byKind.entries()].map(([kind, names]) => ({
    target: "think" as const,
    severity: "warning" as const,
    code: THINK_UNSUPPORTED[kind]!,
    message:
      `<${kind}> records [${names.join(", ")}] have no think-mode mapping (a Think agent has no ` +
      "reconcile loop); they are DROPPED. Use reconcile mode (emitCloudflare) for durable-infra convergence.",
  }));
}

export function formatTargetDiagnosticsForComment(diagnostics: TargetDiagnostic[]): string {
  return diagnostics
    .map((d) => `// TARGET ${d.severity.toUpperCase()} [${d.code}]: ${d.message}`)
    .join("\n");
}
