import { createStore, withOutputs } from "../store.ts";
import { collectInfra } from "../tree.ts";
import { evaluateComponent } from "./evaluate.ts";
import type { AnyAgentSpec } from "../agent-component.tsx";
import type { ChildAgentSpec } from "./emit-cloudflare.ts";
import type { InfraRecord } from "../types.ts";

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

const THINK_BINDING_UNSUPPORTED = {
  callback: "think-callback-binding-unsupported",
  method: "think-method-binding-unsupported",
  result: "think-result-binding-unsupported",
  continuation: "think-continuation-binding-unsupported",
} as const;

function thinkDiagnosticsForRecords(
  records: readonly InfraRecord[],
): TargetDiagnostic[] {
  const unsupportedByKind = new Map<string, string[]>();
  const bindingsByKind = new Map<keyof typeof THINK_BINDING_UNSUPPORTED, string[]>();

  for (const record of records) {
    if (record.kind in THINK_UNSUPPORTED) {
      const names = unsupportedByKind.get(record.kind) ?? [];
      if (!names.includes(record.name)) names.push(record.name);
      unsupportedByKind.set(record.kind, names);
    }
    if (record.kind !== "subagent") continue;
    for (const [capability, binding] of Object.entries(record.bindings ?? {})) {
      const kind = binding.kind;
      const labels = bindingsByKind.get(kind) ?? [];
      const label = `${record.name}.${capability}`;
      if (!labels.includes(label)) labels.push(label);
      bindingsByKind.set(kind, labels);
    }
  }

  const diagnostics: TargetDiagnostic[] = [...unsupportedByKind.entries()].map(
    ([kind, names]) => ({
      target: "think" as const,
      severity: "warning" as const,
      code: THINK_UNSUPPORTED[kind]!,
      message:
        `<${kind}> records [${names.join(", ")}] have no think-mode mapping (a Think agent has no ` +
        "reconcile loop); they are DROPPED. Use reconcile mode (emitCloudflare) for durable-infra convergence.",
    }),
  );

  for (const [kind, labels] of bindingsByKind) {
    const behavior = kind === "result"
      ? "native agentTool returns child output to the parent model but does not invoke the bound parent callable"
      : kind === "continuation"
        ? "native agentTool returns child output to the parent model but does not persist __outputs or expand the parent-owned continuation"
        : `native agentTool does not expose parent-owned ${kind} functions to the child`;
    diagnostics.push({
      target: "think",
      severity: "warning",
      code: THINK_BINDING_UNSUPPORTED[kind],
      message:
        `${kind}-bound capabilities [${labels.join(", ")}] have no Think mapping and are DROPPED; ` +
        `${behavior}. Use emitCloudflare for callable routing or redesign the Think boundary around model-visible input/output.`,
    });
  }

  return diagnostics;
}

/** Native Think agentTool returns a child result to the parent model. It does
 * not invoke agent-jsx's parent-owned `result(callable)` continuation. Surface
 * every such grant instead of silently pretending the target preserved it. */
export function thinkResultBindingDiagnostics(
  records: readonly InfraRecord[],
): TargetDiagnostic[] {
  return thinkDiagnosticsForRecords(records).filter(
    (diagnostic) => diagnostic.code === "think-result-binding-unsupported",
  );
}

export function thinkTargetDiagnostics(
  spec: AnyAgentSpec,
  sampleProps?: Record<string, unknown>,
  analyzedRecords?: readonly InfraRecord[],
): TargetDiagnostic[] {
  if (analyzedRecords) return thinkDiagnosticsForRecords(analyzedRecords);
  try {
    // Sample-output expansion ON so a continuation-gated <task>/<tool> is seen too.
    const roots = withOutputs({ outputs: {}, setOutput: () => {}, expandSamples: true }, () =>
      evaluateComponent(spec.impl, {
        ...(sampleProps ?? spec.sampleProps ?? {}),
        store: createStore(spec.initialState),
        emit: () => {},
      } as never)
    );
    return thinkDiagnosticsForRecords(
      roots.flatMap((root) => collectInfra(root)),
    );
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

}

export function formatTargetDiagnosticsForComment(diagnostics: TargetDiagnostic[]): string {
  return diagnostics
    .map((d) => `// TARGET ${d.severity.toUpperCase()} [${d.code}]: ${d.message}`)
    .join("\n");
}
