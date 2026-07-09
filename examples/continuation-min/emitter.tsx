/**
 * The EMITTING child of a minimal continuation pair (pure compute — no PDF, no
 * network — so the whole round-trip is deterministic on real workerd).
 *
 * Given a `seed` (a comma-separated string pushed down as props), it runs one
 * <task> that splits the seed into items and `emit`s them. It spawns no children
 * of its own; the call site (parent.tsx) owns the continuation that maps those
 * emitted items to one <ContFolder> each. `sampleOutput` is the representative
 * emission the compiler expands that continuation at, so `cont-folder` is
 * discovered (class/binding generated) even though the boundary is output-gated.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";

export interface ContEmitterProps extends Record<string, unknown> {
  /** Comma-separated items to emit, e.g. "a,b". Null at rest, pushed in by props. */
  seed: string | null;
}

export interface ContEmitterState extends Record<string, unknown> {
  /** Once the split task has run and the items have been emitted. */
  emitted: boolean;
}

export const ContEmitter = agentComponent<ContEmitterProps, ContEmitterState, string[]>({
  agentName: "cont-emitter",
  initialState: { emitted: false },
  sampleProps: { seed: null },
  // Representative emitted output — the compiler expands the parent's
  // continuation here so cont-folder is discovered at compile time.
  sampleOutput: ["a", "b"],
  impl: ({ seed, store, emit }) => {
    const { emitted } = useAgentState(store);
    return (
      <>
        {seed && !emitted && (
          <task
            name={`split:${seed}`}
            run={async () => seed.split(",")}
            onDone={async (items) => {
              store.set({ emitted: true });
              // AWAIT the emit: on Cloudflare it is a cross-DO RPC that drives
              // the parent's reconcile (spawning the continuation grandchildren);
              // an un-awaited emit tears the child's I/O context down mid-flight.
              await emit?.(items as string[]);
            }}
          />
        )}
        <prompt>
          <sys p={10}>Split the seed into items and emit them for fan-out.</sys>
          <msg p={6}>{emitted ? "items emitted" : seed ? "splitting…" : "waiting for a seed"}</msg>
        </prompt>
      </>
    );
  },
});
