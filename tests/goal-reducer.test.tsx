/**
 * The goal machine is a REDUCER over a flat table — dep-free, source-attributed.
 *
 * Pinned claims:
 *
 *  1. PURE. `goalReducer(table, snapshot, event)` is a table lookup. It never
 *     mutates the snapshot it was handed, and calling it twice with the same
 *     inputs yields the same output. No xstate, no actors, no scheduler: the
 *     JSX reconciler owns child mounting, and a second scheduler spawning
 *     children behind its back is precisely the conflict this design refuses.
 *
 *  2. REPLAYABLE. Folding the same event log over the same initial snapshot
 *     twice lands on deep-equal state. That is what makes a durable goal
 *     recoverable: the phase is not remembered, it is re-derived.
 *
 *  3. PERSISTED STATE IS PLAIN JSON. Both the table and the snapshot round-trip
 *     through JSON.stringify/parse — including inside the owning agent's whole
 *     durable state blob — and reducing continues correctly on the far side.
 *
 *  4. `done` IS NOT TERMINAL. From `done`, a sensor outcome moves the goal back
 *     to `assess`. `done` is a regular phase — nothing in the table or the
 *     snapshot can even express "halted".
 *
 *  5. THE VOCABULARY IS CLOSED AND PHASE-LOCAL. An outcome with no edge out of
 *     the current phase moves nothing (`ignored: "unknown"`). An outcome whose
 *     SOURCE phase is not the current phase moves nothing (`ignored: "stale"`)
 *     — even when the current phase happens to declare the same outcome name —
 *     so a late child callback after a transition can never corrupt the
 *     machine. Two phases may both use `done` and mean different edges.
 *
 *  6. CHILDREN KNOW NOTHING. A mounted phase child's props are its own
 *     serializable input plus the minted grant — no phase names, no edge maps,
 *     no global event vocabulary (mirrors tests/result-grant.test.tsx).
 */

import { describe, expect, it } from "bun:test";
import { createStore } from "../src/state.ts";
import {
  goalInit,
  goalReducer,
  type GoalEvent,
  type GoalSnapshot,
  type GoalTable,
} from "../src/goal.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { collectInfra } from "../src/tree.ts";
import { declareGoalTable, GoalProvider, initGoalState } from "../examples/goal/goal-provider.tsx";
import {
  declareRepoKeeperGoal,
  initialRepoKeeperDomain,
  type RepoKeeperState,
} from "../examples/goal/repo-keeper.tsx";

const newStore = () => createStore<RepoKeeperState>({ ...initialRepoKeeperDomain, goal: null });

const repoKeeper = (): GoalTable => declareGoalTable(declareRepoKeeperGoal(newStore()));

/** A contextualized outcome, as the provider mints it. */
const ev = (phase: string, type: string, child?: string): GoalEvent => ({
  type,
  source: { phase, ...(child !== undefined ? { child } : {}) },
});

const fold = (table: GoalTable, events: GoalEvent[], from?: GoalSnapshot) =>
  events.reduce(
    (snapshot, event) => goalReducer(table, snapshot, event).next,
    from ?? goalInit(table),
  );

/** The happy path, then a regression, then a repair — the demo's script. Note
 *  the same bare outcome `done` appears with FIVE different source phases. */
const FULL_RUN: GoalEvent[] = [
  ev("assess", "done"),
  ev("plan", "done"),
  ev("upgrade", "done"),
  ev("verify", "done"),
  ev("done", "release_detected"),
  ev("assess", "done"),
  ev("plan", "done"),
  ev("upgrade", "done"),
  ev("verify", "failed"),
  ev("repair", "done"),
  ev("upgrade", "done"),
  ev("verify", "done"),
];

const TO_DONE: GoalEvent[] = [
  ev("assess", "done"),
  ev("plan", "done"),
  ev("upgrade", "done"),
  ev("verify", "done"),
];

describe("goal reducer — pure table lookup, no machine object", () => {
  it("does not mutate the snapshot it was handed", () => {
    const table = repoKeeper();
    const before = goalInit(table);
    const frozen = JSON.parse(JSON.stringify(before)) as GoalSnapshot;

    const step = goalReducer(table, before, ev("assess", "done"));

    expect(before).toEqual(frozen);
    expect(step.next.phase).toBe("plan");
    expect(step.changed).toBe(true);
  });

  it("is a function: the same (snapshot, event) always gives the same result", () => {
    const table = repoKeeper();
    const from = goalInit(table);
    expect(goalReducer(table, from, ev("assess", "done"))).toEqual(
      goalReducer(table, from, ev("assess", "done")),
    );
  });

  it("returns the SAME snapshot object on a no-op — nothing new to persist", () => {
    const table = repoKeeper();
    const from = goalInit(table);
    expect(goalReducer(table, from, ev("assess", "ship_it")).next).toBe(from);
    expect(goalReducer(table, from, ev("verify", "done")).next).toBe(from);
  });
});

describe("goal reducer — replay determinism", () => {
  it("folds the same event log to deep-equal state, twice", () => {
    const table = repoKeeper();
    const first = fold(table, FULL_RUN);
    const second = fold(table, FULL_RUN);
    expect(first).toEqual(second);
    expect(first.phase).toBe("done");
  });

  it("re-derives the same phase on a table rebuilt from the same JSX", () => {
    // Recovery does not restore an object graph; it re-folds the composition
    // and replays. Two independently built tables must agree.
    expect(fold(repoKeeper(), FULL_RUN)).toEqual(fold(repoKeeper(), FULL_RUN));
  });
});

describe("goal reducer — everything durable is plain JSON", () => {
  it("continues reducing correctly after a snapshot round trip", () => {
    const table = repoKeeper();
    const midway = fold(table, [ev("assess", "done"), ev("plan", "done")]);
    const revived = JSON.parse(JSON.stringify(midway)) as GoalSnapshot;

    expect(revived).toEqual(midway);
    expect(goalReducer(table, revived, ev("upgrade", "done")).next.phase).toBe("verify");
  });

  it("the TABLE itself round-trips — the whole machine is data", () => {
    const table = repoKeeper();
    const revived = JSON.parse(JSON.stringify(table)) as GoalTable;
    expect(revived).toEqual(table);
    expect(fold(revived, FULL_RUN)).toEqual(fold(table, FULL_RUN));
  });

  it("survives hibernation of the OWNER's whole durable state blob", () => {
    const table = repoKeeper();
    const store = createStore<RepoKeeperState>(
      initGoalState(table, { ...initialRepoKeeperDomain }),
    );
    store.set((state) => ({ ...state, goal: fold(table, TO_DONE) }));

    // The agent hibernates: only serialized state survives.
    const revived = JSON.parse(store.snapshot()) as RepoKeeperState;
    expect(revived.goal!.phase).toBe("done");

    // And the goal keeps moving on the far side of the round trip.
    const step = goalReducer(table, revived.goal!, ev("done", "release_detected"));
    expect(step.next.phase).toBe("assess");
    expect(step.changed).toBe(true);
  });
});

describe("goal reducer — done is not terminal", () => {
  it("regresses out of done on the sensor outcome", () => {
    const table = repoKeeper();
    const step = goalReducer(table, fold(table, TO_DONE), ev("done", "release_detected"));
    expect(step.next.phase).toBe("assess");
    expect(step.changed).toBe(true);
  });

  it("can be met, knocked out, and met again — an unbounded loop, not a run", () => {
    const table = repoKeeper();
    let snapshot = goalInit(table);
    const met: string[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      snapshot = fold(table, TO_DONE, snapshot);
      met.push(snapshot.phase);
      snapshot = goalReducer(table, snapshot, ev("done", "release_detected")).next;
    }
    expect(met).toEqual(["done", "done", "done"]);
    expect(snapshot.phase).toBe("assess");
  });
});

describe("goal reducer — the vocabulary is closed", () => {
  it("ignores an outcome with no edge out of the current phase, as `unknown`", () => {
    const table = repoKeeper();
    const done = fold(table, TO_DONE);
    // `failed` is legal in `verify`; `done` declares no such edge.
    const step = goalReducer(table, done, ev("done", "failed"));

    expect(step).toEqual({ next: done, changed: false, ignored: "unknown" });
  });

  it("ignores an outcome the goal never declared at all", () => {
    const table = repoKeeper();
    const from = goalInit(table);
    const step = goalReducer(table, from, ev("assess", "ship_it"));

    expect(step.changed).toBe(false);
    expect(step.ignored).toBe("unknown");
    expect(step.next.phase).toBe("assess");
  });

  it("carries a payload without it leaking into durable state, and still only follows declared edges", () => {
    const table = repoKeeper();
    const from = goalInit(table);
    const withPayload: GoalEvent = { ...ev("assess", "done"), payload: { outdated: 7 } };
    const step = goalReducer(table, from, withPayload);
    expect(step.next).toEqual({ phase: "plan" });
    expect(goalReducer(table, from, { ...ev("repair", "done"), payload: 7 }).changed).toBe(false);
  });
});

describe("goal reducer — stale sources are refused (the attribution payoff)", () => {
  it("refuses a late callback from a phase the goal has left, as `stale`", () => {
    const table = repoKeeper();
    const done = fold(table, TO_DONE);
    // The verify worker's grant fires again AFTER verify handed the goal to
    // done. Without attribution this would be indistinguishable from a fresh
    // legal event; with it, the reducer refuses before even looking up edges.
    const step = goalReducer(table, done, ev("verify", "done", "goal:verify"));

    expect(step).toEqual({ next: done, changed: false, ignored: "stale" });
  });

  it("refuses it even when the current phase declares the SAME outcome name", () => {
    const table = repoKeeper();
    const atPlan = fold(table, [ev("assess", "done")]);
    // `plan` declares `done` (-> upgrade). A stale `done` from assess must NOT
    // spend plan's vocabulary — stale wins over the name collision.
    const step = goalReducer(table, atPlan, ev("assess", "done", "goal:assess"));

    expect(step.changed).toBe(false);
    expect(step.ignored).toBe("stale");
    expect(step.next.phase).toBe("plan");
  });

  it("tells stale apart from unknown — a replayer can drop one and alarm on the other", () => {
    const table = repoKeeper();
    const atPlan = fold(table, [ev("assess", "done")]);
    expect(goalReducer(table, atPlan, ev("assess", "done")).ignored).toBe("stale");
    expect(goalReducer(table, atPlan, ev("plan", "ship_it")).ignored).toBe("unknown");
  });
});

describe("goal reducer — the vocabulary is phase-local", () => {
  it("routes the same bare outcome differently per source phase", () => {
    const table = repoKeeper();
    // `done` from assess -> plan; `done` from verify -> done. Same word, two edges.
    expect(goalReducer(table, { phase: "assess" }, ev("assess", "done")).next.phase).toBe("plan");
    expect(goalReducer(table, { phase: "verify" }, ev("verify", "done")).next.phase).toBe("done");
    expect(goalReducer(table, { phase: "repair" }, ev("repair", "done")).next.phase).toBe("upgrade");
  });
});

describe("goal provider — children receive no graph knowledge", () => {
  it("mounts the active phase's worker with ONLY its own input plus the grant", () => {
    const table = repoKeeper();
    const store = newStore();
    const [worker, ...rest] = evaluateTree(
      <GoalProvider table={table} store={store}>
        {declareRepoKeeperGoal(store)}
      </GoalProvider>,
    ).flatMap((root) => collectInfra(root));

    expect(rest).toEqual([]);
    // Durable child input: its own serializable task. No phase names, no `on`
    // maps, no initial markers, no event vocabulary.
    expect(worker?.config).toEqual({ kind: "phase-worker", task: "assess" });
    // The grant is binding METADATA, not child input — and it is the only one.
    expect(worker?.bindings).toEqual({ onOutcome: { kind: "result" } });
    expect(Object.keys(worker?.handlers ?? {})).toEqual(["onOutcome"]);
  });
});
