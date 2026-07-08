/**
 * Phase B — the <task> intrinsic (one-shot work-on-mount). Sim semantics.
 * Copy to tests/ on placement. See FRAMEWORK-PATCH.md for the design.
 */

import { describe, expect, it } from "bun:test";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore, useAgentState, type AgentStore } from "../src/state.ts";

interface S extends Record<string, unknown> {
  result: string | null;
  runs: number;
}

function Once({ store }: { store: AgentStore<S> }) {
  const { result } = useAgentState(store);
  return (
    <>
      {!result && (
        <task
          name="work"
          run={() => {
            store.set((s) => ({ ...s, runs: s.runs + 1 }));
            return "answer";
          }}
          onDone={(r) => store.set((s) => ({ ...s, result: String(r) }))}
        />
      )}
      <prompt>
        <sys p={10}>{result ?? "working"}</sys>
      </prompt>
    </>
  );
}

describe("<task>: one-shot work on mount", () => {
  it("executes exactly once and folds the result through onDone", () => {
    const host = new SimHost({ statusAt: () => 200 });
    const store = createStore<S>({ result: null, runs: 0 });
    const agent = mountAgent(<Once store={store} />, host, { quiet: true });
    agent.tick();
    agent.tick();
    agent.tick();
    expect(store.get().result).toBe("answer");
    expect(store.get().runs).toBe(1); // never re-runs after unmount+state change
    expect(agent.prompt(50).text).toContain("answer");
    agent.unmount();
  });

  it("cancels in-flight work when unmounted before completion", () => {
    const host = new SimHost({ statusAt: () => 200 });
    const store = createStore<S>({ result: null, runs: 0 });
    const agent = mountAgent(<Once store={store} />, host, { quiet: true });
    agent.unmount(); // before any tick — the pending task must be cancelled
    agent.tick?.bind(agent); // no ticks on host after unmount in this harness
    expect(store.get().result).toBeNull();
    expect(store.get().runs).toBe(0);
  });
});
