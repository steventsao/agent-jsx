/**
 * JSX authors the machine. The RUNTIME target is a flat table (src/goal.ts,
 * dep-free); XState is a DEV-TIME target for analysis and visualization only.
 *
 * Pinned claims:
 *
 *  1. TABLE BUILDING IS TOTAL. The `<phase>` elements a composition declares
 *     fold to an exact `GoalTable`. The expected JSON is written out in full
 *     below — if the folding changes, this diff IS the changelog.
 *
 *  2. THE TABLE IS DATA. It survives JSON.stringify/parse unchanged: no
 *     closures, no class instances, no machine objects. Its outcome keys are
 *     PHASE-LOCAL — the same bare name may appear under many phases.
 *
 *  3. EVERY PHASE IS DECLARED; ONE PHASE MOUNTS. The provider re-declares the
 *     whole graph on every render regardless of which phase is active, so the
 *     transition graph is collectable as data at any moment — while only the
 *     ACTIVE phase's children reconcile into host records. `<phase>` itself
 *     reconciles to NOTHING: a phase is not infrastructure.
 *
 *  4. XSTATE LOWERING IS DEV-TIME. `lowerGoalToMachine` (examples/goal/
 *     goal-dev.ts) emits a serializable XState v5 config whose event names are
 *     namespaced `<phase>.<outcome>` — a global statechart needs globally
 *     unique events, and the namespacing is the honest picture of a
 *     source-attributed vocabulary. Nothing under src/ imports xstate.
 *
 *  5. THE ORACLE BITES. An `on` target naming a phase that was never mounted is
 *     carried through folding VERBATIM and reported by analyzeGoal. Dropping it
 *     silently would turn an authoring bug into a machine that merely does
 *     nothing; XState itself only reports it as a constructor crash.
 */

import { describe, expect, it } from "bun:test";
import { createMachine } from "xstate";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { createStore } from "../src/state.ts";
import { Phase } from "../src/agent-component.tsx";
import { collectInfra, collectPhases } from "../src/tree.ts";
import {
  buildGoalTable,
  goalInit,
  goalReducer,
  type GoalEvent,
  type GoalSnapshot,
  type GoalTable,
} from "../src/goal.ts";
import {
  analyzeGoal,
  lowerGoalToMachine,
  type GoalMachineConfig,
} from "../examples/goal/goal-dev.ts";
import { declareGoalTable, GoalProvider, type GoalApi } from "../examples/goal/goal-provider.tsx";
import {
  declareRepoKeeperGoal,
  initialRepoKeeperDomain,
  REPO_KEEPER_GOAL_ID,
  type RepoKeeperState,
} from "../examples/goal/repo-keeper.tsx";

/** The runtime IR: phase-local outcomes, flat edges, no id, no machine. */
const REPO_KEEPER_TABLE: GoalTable = {
  initial: "assess",
  edges: {
    assess: { done: "plan" },
    plan: { done: "upgrade" },
    upgrade: { done: "verify" },
    verify: { done: "done", failed: "repair" },
    repair: { done: "upgrade" },
    done: { release_detected: "assess" },
  },
};

/** The dev-time IR: the same table, namespaced for a flat global statechart. */
const REPO_KEEPER_XSTATE_IR: GoalMachineConfig = {
  id: "repo-keeper",
  initial: "assess",
  states: {
    assess: { on: { "assess.done": { target: "plan" } } },
    plan: { on: { "plan.done": { target: "upgrade" } } },
    upgrade: { on: { "upgrade.done": { target: "verify" } } },
    verify: {
      on: { "verify.done": { target: "done" }, "verify.failed": { target: "repair" } },
    },
    repair: { on: { "repair.done": { target: "upgrade" } } },
    done: { on: { "done.release_detected": { target: "assess" } } },
  },
};

const newStore = () =>
  createStore<RepoKeeperState>({ ...initialRepoKeeperDomain, goal: null });

const repoKeeperTable = () => declareGoalTable(declareRepoKeeperGoal(newStore()));

const ev = (phase: string, type: string): GoalEvent => ({ type, source: { phase } });

/** Drive the goal to a phase purely, so a test can mount the provider there. */
function snapshotAfter(events: GoalEvent[]): GoalSnapshot {
  const table = repoKeeperTable();
  return events.reduce(
    (snapshot, event) => goalReducer(table, snapshot, event).next,
    goalInit(table),
  );
}

const TO_DONE = [ev("assess", "done"), ev("plan", "done"), ev("upgrade", "done"), ev("verify", "done")];

describe("goal table — <phase> declarations fold to the runtime table", () => {
  it("folds the repo-keeper composition to exactly this table", () => {
    expect(repoKeeperTable()).toEqual(REPO_KEEPER_TABLE);
  });

  it("collects the graph from the SAME sweep the reconciler commits", () => {
    const phases = evaluateTree(
      declareRepoKeeperGoal(newStore())({
        phase: "",
        snapshot: { phase: "" },
        dispatchFor: () => () => {},
      } satisfies GoalApi),
    ).flatMap((root) => collectPhases(root));

    expect(phases.map((phase) => phase.name)).toEqual([
      "assess",
      "plan",
      "upgrade",
      "verify",
      "repair",
      "done",
    ]);
    expect(phases.filter((phase) => phase.initial).map((phase) => phase.name)).toEqual(["assess"]);
    expect(buildGoalTable(phases)).toEqual(REPO_KEEPER_TABLE);
  });

  it("survives a JSON round trip unchanged — the whole machine is data", () => {
    const table = repoKeeperTable();
    expect(JSON.parse(JSON.stringify(table))).toEqual(table);
  });

  it("keeps the outcome vocabulary phase-local: five phases spend the same bare `done`", () => {
    const { edges } = repoKeeperTable();
    const phasesUsingDone = Object.keys(edges).filter((phase) => "done" in edges[phase]!);
    expect(phasesUsingDone).toEqual(["assess", "plan", "upgrade", "verify", "repair"]);
    // ...and each spend is its own edge — the word routes by its source phase.
    expect(phasesUsingDone.map((phase) => edges[phase]!.done)).toEqual([
      "plan",
      "upgrade",
      "verify",
      "done",
      "upgrade",
    ]);
  });
});

describe("goal lowering — XState is a dev-time target, events namespaced", () => {
  it("lowers the table to exactly this XState v5 config", () => {
    expect(lowerGoalToMachine(repoKeeperTable(), { id: REPO_KEEPER_GOAL_ID })).toEqual(
      REPO_KEEPER_XSTATE_IR,
    );
  });

  it("emits data XState accepts, that survives a JSON round trip", () => {
    const config = lowerGoalToMachine(repoKeeperTable(), { id: REPO_KEEPER_GOAL_ID });
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
    expect(() => createMachine(config as never)).not.toThrow();
  });

  it("never emits a final state — `done` must stay escapable", () => {
    const config = lowerGoalToMachine(repoKeeperTable(), { id: REPO_KEEPER_GOAL_ID });
    expect(JSON.stringify(config)).not.toContain("final");
    // The claim that matters is behavioral, and it belongs to the RUNTIME: the
    // reducer still leaves `done` on its sensor edge.
    const step = goalReducer(repoKeeperTable(), snapshotAfter(TO_DONE), ev("done", "release_detected"));
    expect(step.next.phase).toBe("assess");
    expect(step.changed).toBe(true);
  });
});

describe("goal table — the provider declares every phase, mounts one", () => {
  it("reports the whole graph no matter which phase is active", () => {
    const table = repoKeeperTable();

    for (const events of [[], [ev("assess", "done")], TO_DONE]) {
      const store = newStore();
      store.set((state) => ({ ...state, goal: snapshotAfter(events) }));
      const roots = evaluateTree(
        <GoalProvider table={table} store={store}>
          {declareRepoKeeperGoal(store)}
        </GoalProvider>,
      );
      expect(roots.flatMap((root) => collectPhases(root)).map((phase) => phase.name)).toEqual([
        "assess",
        "plan",
        "upgrade",
        "verify",
        "repair",
        "done",
      ]);
    }
  });

  it("mounts ONLY the active phase's children, and no record for <phase> itself", () => {
    const table = repoKeeperTable();
    const mountedAt = (events: GoalEvent[]) => {
      const store = newStore();
      store.set((state) => ({ ...state, goal: snapshotAfter(events) }));
      return evaluateTree(
        <GoalProvider table={table} store={store}>
          {declareRepoKeeperGoal(store)}
        </GoalProvider>,
      )
        .flatMap((root) => collectInfra(root))
        .map((record) => `${record.kind}:${record.name}`);
    };

    expect(mountedAt([])).toEqual(["subagent:goal:assess"]);
    expect(mountedAt([ev("assess", "done")])).toEqual(["subagent:goal:plan"]);
    // `done` mounts a watch, not a worker — the goal is met but still supervised.
    expect(mountedAt(TO_DONE)).toEqual(["sensor:goal:releases"]);
  });

  it("grants the minted dispatch as a result binding, never as a bare function", () => {
    const table = repoKeeperTable();
    const store = newStore();
    const [worker] = evaluateTree(
      <GoalProvider table={table} store={store}>
        {declareRepoKeeperGoal(store)}
      </GoalProvider>,
    ).flatMap((root) => collectInfra(root));

    expect(worker?.bindings).toEqual({ onOutcome: { kind: "result" } });
    // The closure rides host-side; the child's durable input is config only.
    expect(worker?.config).toEqual({ kind: "phase-worker", task: "assess" });
  });
});

describe("goal table — the oracle bites", () => {
  const danglingDeclaration = () => (
    <>
      <Phase name="assess" initial on={{ done: "plan" }} />
      {/* "shipit" is never mounted as a <phase> */}
      <Phase name="plan" on={{ done: "shipit" }} />
      <Phase name="done" on={{ release_detected: "assess" }} />
    </>
  );

  it("carries an unmounted edge target through folding instead of dropping it", () => {
    const phases = evaluateTree(danglingDeclaration()).flatMap((root) => collectPhases(root));
    const table = buildGoalTable(phases);
    expect(table.edges.plan?.done).toBe("shipit");
  });

  it("surfaces it as a diagnostic — the thing XState only reports by crashing", () => {
    const phases = evaluateTree(danglingDeclaration()).flatMap((root) => collectPhases(root));
    const table = buildGoalTable(phases);

    expect(analyzeGoal(table)).toEqual([
      {
        target: "goal",
        severity: "error",
        code: "goal-unknown-target",
        message:
          'phase "plan" edge done targets "shipit", which is not a declared <phase>; declared: [assess, plan, done].',
      },
    ]);
    expect(() =>
      createMachine(lowerGoalToMachine(table, { id: "dangling" }) as never),
    ).toThrow();
  });

  it("rejects an edge whose target is not a serializable phase name", () => {
    expect(() =>
      evaluateTree(
        <Phase name="assess" on={{ done: (() => "plan") as unknown as string }} />,
      ).flatMap((root) => collectPhases(root)),
    ).toThrow(
      '<phase name="assess"> edge "done" must name a target phase (a serializable string), not function',
    );
  });

  it("rejects a duplicate phase name — a phase name IS the table's state key", () => {
    const phases = evaluateTree(
      <>
        <Phase name="assess" initial on={{ done: "assess" }} />
        <Phase name="assess" on={{ again: "assess" }} />
      </>,
    ).flatMap((root) => collectPhases(root));
    expect(() => buildGoalTable(phases)).toThrow('[goal] duplicate <phase name="assess">');
  });

  it("rejects more than one initial phase", () => {
    const phases = evaluateTree(
      <>
        <Phase name="assess" initial on={{ done: "done" }} />
        <Phase name="done" initial on={{ release_detected: "assess" }} />
      </>,
    ).flatMap((root) => collectPhases(root));
    expect(() => buildGoalTable(phases)).toThrow(
      "[goal] more than one <phase initial>: assess, done",
    );
  });

  it("rejects a goal with no phases at all", () => {
    expect(() => buildGoalTable([])).toThrow("[goal] a goal must declare at least one <phase>");
  });

  it("rejects a non-<phase> element at the provider's declaration level", () => {
    const table = repoKeeperTable();
    const store = newStore();
    expect(() =>
      evaluateTree(
        <GoalProvider table={table} store={store}>
          {() => (
            <>
              <Phase name="assess" initial on={{ done: "assess" }} />
              {/* would mount in EVERY phase while looking like it belongs to one */}
              <tool name="stray" description="not scoped to any phase" run={() => "x"} />
            </>
          )}
        </GoalProvider>,
      ),
    ).toThrow("[goal] GoalProvider children may only declare <Phase> elements; found <tool>");
  });
});
