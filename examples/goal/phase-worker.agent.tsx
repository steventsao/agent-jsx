/**
 * The one repo-keeper child agent — an authored function component sealed by
 * its profile: identity, model, and initial state live beside the function.
 * Its props ARE its contract: the work it is executing, and the one line back
 * out. NOTHING here knows the graph: no phase names, no edge maps, no global
 * event vocabulary — just `dispatch(outcome)`.
 *
 * The compiler owns the boundary: ./generated/phase-worker.compiled.tsx
 * (emitted by ./generate.tsx) re-exports this worker under the same public
 * JSX name, and ./repo-keeper.tsx composes that.
 */

import { defineAgentProfile } from "../../src/agent-component.tsx";

export interface PhaseWorkerProps {
  /** The work this worker is executing. Serializable input. */
  task: string;
  /**
   * The bare, child-local outcome this worker reports when its work lands
   * (`"done"` or `"failed"`). Granted at the composition site as
   * `result(dispatchFor(phase, child))` — never a bare function. The child
   * never holds the closure; the host invokes the parent-side sink when the
   * child's work completes, the provider stamps the SOURCE it minted the grant
   * with, and only the ROUTE survives hibernation.
   */
  onOutcome: (outcome: string) => void;
}

export interface PhaseWorkerState extends Record<string, unknown> {
  runs: number;
}

/** Identity, model, and authority stay explicit; only boundary glue is generated. */
export const profile = defineAgentProfile<PhaseWorkerProps, PhaseWorkerState>({
  name: "phase-worker",
  model: "sim/phase-worker",
  description: "Executes one unit of goal work and reports a bare outcome.",
  initialState: { runs: 0 },
  sampleProps: { task: "assess", onOutcome: () => {} },
  capabilities: { onOutcome: "result" },
});

/** A normal pure JSX component. The compiler, not this file, makes it a boundary. */
export default function PhaseWorker({ task }: PhaseWorkerProps) {
  return (
    <prompt>
      <sys p={10}>
        You execute the "{task}" work of a goal that keeps a repository's
        dependencies fresh.
      </sys>
      <msg p={7}>Report exactly one outcome ("done" or "failed") when the work lands.</msg>
    </prompt>
  );
}
