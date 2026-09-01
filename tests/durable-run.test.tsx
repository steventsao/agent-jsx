/**
 * `<DurableRun>` — the durable leaf the goal layer mounts.
 *
 * Layer 1 (engine): the plain-async executor over the Effect workflow engine.
 * The authored surface is `defineDurableWorkflow({ name, run })` with
 * `step.do` checkpoints — no Effect type appears in any test below, which is
 * itself part of the contract under test.
 *
 * Layer 2 (host): the `durable` record in SimHost — result routing, unmount
 * revocation, remount replay, and hibernation with the engine surviving (the
 * engine plays the role DO-side storage plays in production: it outlives the
 * process the reconciler runs in).
 */

import { describe, expect, it } from "bun:test";
import { mountAgent } from "../src/agent.ts";
import { result } from "../src/agent-class.tsx";
import { DurableRun } from "../src/agent-component.tsx";
import { SimHost, type World } from "../src/sim-host.ts";
import { createStore, useAgentState, type AgentStore } from "../src/state.ts";
import {
  canonicalJson,
  createDurableEngine,
  defineDurableWorkflow,
  type DurableEngine,
  type DurableStep,
} from "../src/durable.ts";
import {
  declareGoalTable,
  GoalProvider,
  initGoalState,
  type GoalApi,
  type GoalOwnerState,
  type GoalTransition,
} from "../examples/goal/goal-provider.tsx";

// ---------------------------------------------------------------------------
// Layer 1 — the engine alone

describe("durable engine: exactly-once execution", () => {
  it("replays a completed run instead of re-running it", async () => {
    const effects: string[] = [];
    const Upgrade = defineDurableWorkflow({
      name: "Upgrade",
      run: async (payload: { pkg: string }, step: DurableStep) => {
        return step.do("bump", () => {
          effects.push(payload.pkg);
          return `bumped ${payload.pkg} (attempt ${effects.length})`;
        });
      },
    });
    const engine = createDurableEngine({ workflows: [Upgrade] });
    try {
      const first = await engine.execute({ workflow: "Upgrade", payload: { pkg: "react" } });
      expect(first).toBe("bumped react (attempt 1)");
      expect(effects).toEqual(["react"]);

      // Same (workflow, payload) → the SAME durable execution: a replay.
      const second = await engine.execute({ workflow: "Upgrade", payload: { pkg: "react" } });
      expect(second).toBe("bumped react (attempt 1)");
      expect(effects).toEqual(["react"]);

      expect(await engine.isComplete({ workflow: "Upgrade", payload: { pkg: "react" } })).toBe(true);
    } finally {
      await engine.dispose();
    }
  });

  it("the oracle bites: a different payload is a different execution and DOES run", async () => {
    const effects: string[] = [];
    const Upgrade = defineDurableWorkflow({
      name: "Upgrade",
      run: async (payload: { pkg: string }, step: DurableStep) =>
        step.do("bump", () => {
          effects.push(payload.pkg);
          return effects.length;
        }),
    });
    const engine = createDurableEngine({ workflows: [Upgrade] });
    try {
      await engine.execute({ workflow: "Upgrade", payload: { pkg: "react" } });
      const other = await engine.execute({ workflow: "Upgrade", payload: { pkg: "vite" } });
      expect(other).toBe(2);
      expect(effects).toEqual(["react", "vite"]);

      const a = await engine.executionId({ workflow: "Upgrade", payload: { pkg: "react" } });
      const b = await engine.executionId({ workflow: "Upgrade", payload: { pkg: "vite" } });
      expect(a).not.toBe(b);
    } finally {
      await engine.dispose();
    }
  });

  it("addresses one execution regardless of payload key order (canonical identity)", async () => {
    const engine = createDurableEngine({
      workflows: [
        defineDurableWorkflow({
          name: "Noop",
          run: async () => "ok",
        }),
      ],
    });
    try {
      const a = await engine.executionId({ workflow: "Noop", payload: { a: 1, b: 2 } });
      const b = await engine.executionId({ workflow: "Noop", payload: { b: 2, a: 1 } });
      expect(a).toBe(b);
      expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    } finally {
      await engine.dispose();
    }
  });

  it("step.do retries live within one run (attempts), persisting only the settled outcome", async () => {
    let failures = 2;
    const runs: string[] = [];
    const Flaky = defineDurableWorkflow({
      name: "Flaky",
      run: async (_payload: Record<string, unknown>, step: DurableStep) =>
        step.do(
          "fetch",
          () => {
            runs.push("fetch");
            if (failures > 0) {
              failures -= 1;
              throw new Error("transient");
            }
            return "fetched";
          },
          { attempts: 3 },
        ),
    });
    const engine = createDurableEngine({ workflows: [Flaky] });
    try {
      expect(await engine.execute({ workflow: "Flaky" })).toBe("fetched");
      expect(runs).toEqual(["fetch", "fetch", "fetch"]);

      // The settled SUCCESS is what persisted: a re-execution replays it.
      expect(await engine.execute({ workflow: "Flaky" })).toBe("fetched");
      expect(runs.length).toBe(3);
    } finally {
      await engine.dispose();
    }
  });

  it("failure is durable: re-executing a failed identity replays the failure, not a fresh attempt", async () => {
    // The contract this pins is the Cloudflare Workflows errored-instance
    // model: once an execution settles — success OR failure — its identity is
    // spent. A goal that wants another try mounts a NEW instance (same
    // workflow, changed payload; an attempt counter is the usual shape).
    let shouldFail = true;
    const stepRuns: string[] = [];
    const Deploy = defineDurableWorkflow({
      name: "Deploy",
      run: async (payload: { attempt: number }, step: DurableStep) => {
        const built = await step.do("build", () => {
          stepRuns.push(`build#${payload.attempt}`);
          return "artifact";
        });
        return step.do("ship", () => {
          stepRuns.push(`ship#${payload.attempt}`);
          if (shouldFail) throw new Error("registry unreachable");
          return `${built} shipped`;
        });
      },
    });
    const engine = createDurableEngine({ workflows: [Deploy] });
    try {
      const first = { workflow: "Deploy", payload: { attempt: 1 } };
      await expect(engine.execute(first)).rejects.toThrow("registry unreachable");
      expect(stepRuns).toEqual(["build#1", "ship#1"]);

      // Same identity again: the persisted failure REPLAYS. No step re-runs.
      shouldFail = false;
      await expect(engine.execute(first)).rejects.toThrow("registry unreachable");
      expect(stepRuns).toEqual(["build#1", "ship#1"]);

      // A fresh attempt is a NEW instance — and it succeeds.
      const second = { workflow: "Deploy", payload: { attempt: 2 } };
      expect(await engine.execute(second)).toBe("artifact shipped");
      expect(stepRuns).toEqual(["build#1", "ship#1", "build#2", "ship#2"]);
    } finally {
      await engine.dispose();
    }
  });

  it("rejects an unknown workflow name loudly", async () => {
    const engine = createDurableEngine({
      workflows: [defineDurableWorkflow({ name: "Known", run: async () => null })],
    });
    try {
      await expect(engine.execute({ workflow: "Unknown" })).rejects.toThrow(
        'unknown workflow "Unknown"',
      );
    } finally {
      await engine.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the <DurableRun> record under SimHost

/** A fresh Upgrade workflow + engine per test, with an effects log the tests
 *  read to prove exactly-once. */
function makeUpgradeEngine(): { engine: DurableEngine; effects: string[] } {
  const effects: string[] = [];
  const Upgrade = defineDurableWorkflow({
    name: "Upgrade",
    run: async (payload: { pkg: string }, step: DurableStep) =>
      step.do("bump", () => {
        effects.push(payload.pkg);
        return `bumped ${payload.pkg} (attempt ${effects.length})`;
      }),
  });
  return { engine: createDurableEngine({ workflows: [Upgrade] }), effects };
}

interface LeafState extends Record<string, unknown> {
  results: string[];
  mounted: boolean;
}

/** Mounts the leaf while `mounted`; every delivery appends to `results`. */
function Leaf({ store }: { store: AgentStore<LeafState> }) {
  const { mounted, results } = useAgentState(store);
  return (
    <>
      {mounted && (
        <DurableRun
          name="leaf"
          workflow="Upgrade"
          payload={{ pkg: "react" }}
          onResult={(r) => store.set((s) => ({ ...s, results: [...s.results, String(r)] }))}
        />
      )}
      <prompt>
        <sys p={10}>{results[results.length - 1] ?? "running"}</sys>
      </prompt>
    </>
  );
}

describe("<DurableRun> under SimHost", () => {
  it("executes on the world's engine and folds the result through onResult", async () => {
    const { engine, effects } = makeUpgradeEngine();
    try {
      const host = new SimHost({ statusAt: () => 200, durable: engine });
      const store = createStore<LeafState>({ results: [], mounted: true });
      const agent = mountAgent(<Leaf store={store} />, host, { quiet: true });
      agent.tick();
      await host.settle();
      expect(store.get().results).toEqual(["bumped react (attempt 1)"]);
      expect(effects).toEqual(["react"]);
      expect(agent.prompt(50).text).toContain("bumped react");
      agent.unmount();
    } finally {
      await engine.dispose();
    }
  });

  it("unmount before the start tick cancels — nothing ever executes", async () => {
    const { engine, effects } = makeUpgradeEngine();
    try {
      const host = new SimHost({ statusAt: () => 200, durable: engine });
      const store = createStore<LeafState>({ results: [], mounted: true });
      const agent = mountAgent(<Leaf store={store} />, host, { quiet: true });
      agent.unmount();
      await host.settle();
      expect(store.get().results).toEqual([]);
      expect(effects).toEqual([]);
    } finally {
      await engine.dispose();
    }
  });

  it("a remounted leaf joins the SAME execution: the result replays, the effects do not", async () => {
    const { engine, effects } = makeUpgradeEngine();
    try {
      const host = new SimHost({ statusAt: () => 200, durable: engine });
      const store = createStore<LeafState>({ results: [], mounted: true });
      const agent = mountAgent(<Leaf store={store} />, host, { quiet: true });
      agent.tick();
      await host.settle();
      expect(store.get().results).toEqual(["bumped react (attempt 1)"]);

      // Phase change away: the leaf unmounts. Phase change back: it remounts.
      agent.dispatch(() => store.set((s) => ({ ...s, mounted: false })));
      agent.dispatch(() => store.set((s) => ({ ...s, mounted: true })));
      agent.tick();
      await host.settle();

      // Delivered again — from storage. The workflow body never re-ran.
      expect(store.get().results).toEqual([
        "bumped react (attempt 1)",
        "bumped react (attempt 1)",
      ]);
      expect(effects).toEqual(["react"]);
      agent.unmount();
    } finally {
      await engine.dispose();
    }
  });

  it("survives hibernation: the restored record replays from the engine, handlers rebound", async () => {
    const { engine, effects } = makeUpgradeEngine();
    try {
      const world: World = { statusAt: () => 200, durable: engine };
      const host = new SimHost(world);
      const store = createStore<LeafState>({ results: [], mounted: true });
      const agent = mountAgent(<Leaf store={store} />, host, { quiet: true });
      agent.tick();
      await host.settle();
      expect(effects).toEqual(["react"]);

      // "Hibernate": only (kind, name, config) survive. The ENGINE survives
      // too — it is the durable storage a DO would keep under the process.
      const snapshot = host.snapshot();
      agent.unmount();

      const woken = SimHost.restore(snapshot, world, host.t);
      const freshStore = createStore<LeafState>({ results: [], mounted: true });
      const rebooted = mountAgent(<Leaf store={freshStore} />, woken, { quiet: true });
      rebooted.tick();
      await woken.settle();

      expect(freshStore.get().results).toEqual(["bumped react (attempt 1)"]);
      expect(effects).toEqual(["react"]); // replay, not a second run
      rebooted.unmount();
    } finally {
      await engine.dispose();
    }
  });

  it("throws loudly when a <durable> record mounts with no engine in the World", async () => {
    const host = new SimHost({ statusAt: () => 200 });
    const store = createStore<LeafState>({ results: [], mounted: true });
    const agent = mountAgent(<Leaf store={store} />, host, { quiet: true });
    expect(() => agent.tick()).toThrow("no durable engine");
    agent.unmount();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — the durable leaf as a goal-phase child: the shape the goal layer
// was designed around. The machine supervises; the leaf sequences.

interface GoalLeafState extends GoalOwnerState {
  delivered: string[];
}

describe("<DurableRun> inside a goal phase", () => {
  it("its granted result moves the machine, with facets-style attribution", async () => {
    const { engine, effects } = makeUpgradeEngine();
    try {
      const store = createStore<GoalLeafState>({ delivered: [], goal: null });
      const declare = ({ dispatchFor }: GoalApi) => {
        const dispatch = dispatchFor("upgrade", "goal:upgrade-run");
        return (
          <>
            <phase name="upgrade" initial on={{ done: "verify" }}>
              <DurableRun
                name="goal:upgrade-run"
                workflow="Upgrade"
                payload={{ pkg: "react" }}
                onResult={result((r: unknown) => {
                  store.set((s) => ({ ...s, delivered: [...s.delivered, String(r)] }));
                  dispatch("done", r);
                })}
              />
            </phase>
            <phase name="verify" on={{ done: "done" }} />
            <phase name="done" />
          </>
        );
      };

      const table = declareGoalTable(declare);
      store.set((s) => initGoalState(table, s));

      const transitions: GoalTransition[] = [];
      const host = new SimHost({ statusAt: () => 200, durable: engine });
      const agent = mountAgent(
        <GoalProvider table={table} store={store} onTransition={(t) => transitions.push(t)}>
          {declare}
        </GoalProvider>,
        host,
        { quiet: true },
      );

      agent.tick();
      await host.settle();

      // The leaf's replayed-or-fresh result spent the upgrade phase's `done`
      // edge, attributed to the child the grant was minted for.
      expect(store.get().goal).toEqual({ phase: "verify" });
      expect(store.get().delivered).toEqual(["bumped react (attempt 1)"]);
      expect(effects).toEqual(["react"]);
      expect(transitions).toEqual([
        {
          outcome: "done",
          source: { phase: "upgrade", child: "goal:upgrade-run" },
          from: "upgrade",
          to: "verify",
          changed: true,
        },
      ]);
      // Leaving the phase unmounted the leaf.
      expect([...(host.liveRecords as Map<string, unknown>).keys()]).not.toContain(
        "durable:goal:upgrade-run",
      );
      agent.unmount();
    } finally {
      await engine.dispose();
    }
  });
});
