import { createStore } from "../store.ts";
import { collectInfra } from "../tree.ts";
import { evaluateComponent } from "./evaluate.ts";
import type { ChildAgentSpec } from "./emit-cloudflare.ts";

export type TargetDiagnosticSeverity = "warning" | "error";

export interface TargetDiagnostic {
  target: "flue";
  severity: TargetDiagnosticSeverity;
  code: string;
  message: string;
}

const formatInfra = (child: ChildAgentSpec) => {
  const roots = evaluateComponent(child.spec.impl, {
    ...(child.spec.sampleProps ?? {}),
    store: createStore(child.spec.initialState),
  } as never);
  return roots.flatMap((root) => collectInfra(root)).map((r) => `${r.kind}:${r.name}`);
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

export function formatTargetDiagnosticsForComment(diagnostics: TargetDiagnostic[]): string {
  return diagnostics
    .map((d) => `// TARGET ${d.severity.toUpperCase()} [${d.code}]: ${d.message}`)
    .join("\n");
}
