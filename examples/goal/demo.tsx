/**
 * `bun examples/goal/demo.tsx` — the repo-keeper goal, end to end, offline.
 *
 * Five things to watch in the output:
 *
 *   1. THE RUNTIME IS A TABLE. The transition table printed at the top was not
 *      written; it was folded out of the `<phase>` elements the composition
 *      declares. It is plain JSON — `edges[phase][outcome] -> target` — and the
 *      reducer that moves it is a dep-free lookup (src/goal.ts). XState appears
 *      only as the DEV-TIME IR below it, with event names namespaced
 *      `<phase>.<outcome>`, for @xstate/graph analysis and Stately viz.
 *
 *   2. STATIC CHECKS RUN BEFORE ANYTHING MOUNTS. `analyzeGoal` walks the graph
 *      and reports dangling edges, unreachable phases, an unreachable `done`,
 *      and dead ends. A healthy goal reports nothing.
 *
 *   3. CHILDREN ARE DUMB DISPATCHERS. Every transition line shows ATTRIBUTION:
 *      `upgrade[goal:upgrade] done ▶ verify` means the child only said "done" —
 *      the provider that minted its grant knew the source phase and child
 *      (cloudflare/agents facets style) and contextualized the event. Five
 *      phases all say `done` and it means five different edges.
 *
 *   4. A STALE GRANT CANNOT CORRUPT THE MACHINE. After the goal re-converges on
 *      `done`, a LATE callback from the verify worker's grant fires again — and
 *      is refused as stale, because its minted source phase is no longer the
 *      current phase. That refusal is the attribution payoff.
 *
 *   5. `done` IS NOT THE END. At t=6 a SENSOR mounted by the `done` phase sees
 *      a new upstream release and knocks the goal back to `assess`. The second
 *      pass fails verification and takes the repair edge. Neither is
 *      expressible inside a finished linear run.
 *
 * No model is called. A scripted SimHost world plays every child's outcome, so
 * the entire transcript below is deterministic and byte-stable.
 */

import { mountAgent } from "../../src/agent.ts";
import { SimHost, type World } from "../../src/sim-host.ts";
import { createStore } from "../../src/state.ts";
import { goalReducer } from "../../src/goal.ts";
import { analyzeGoal, lowerGoalToMachine } from "./goal-dev.ts";
import {
  declareGoalTable,
  GoalProvider,
  initGoalState,
  type GoalDispatch,
  type GoalTransition,
} from "./goal-provider.tsx";
import {
  declareRepoKeeperGoal,
  initialRepoKeeperDomain,
  RELEASE_FEED,
  REPO_KEEPER_GOAL_ID,
  type RepoKeeperState,
} from "./repo-keeper.tsx";

// ---------------------------------------------------------------------------
// A scripted world. Each phase worker's outcome is fixed in advance, in order —
// verification succeeds, then fails, then succeeds. Upstream publishes release
// 2 at t=6, which the `done` phase's sensor is watching for. Note the script
// speaks the CHILD's vocabulary: bare outcomes, no phase names, no edges.

const SCRIPT: Record<string, string[]> = {
  assess: ["done", "done"],
  plan: ["done", "done"],
  upgrade: ["done", "done", "done"],
  verify: ["done", "failed", "done"],
  repair: ["done"],
};

const RELEASE_PUBLISHED_AT = 6;

const cursor = new Map<string, number>();
const world: World = {
  subagentLatency: 1,
  statusAt: (url, t) => (url === RELEASE_FEED ? (t >= RELEASE_PUBLISHED_AT ? 2 : 1) : 200),
  subagentResult: (record) => {
    const task = String(record.config.task);
    const attempt = cursor.get(task) ?? 0;
    cursor.set(task, attempt + 1);
    const outcome = SCRIPT[task]?.[attempt];
    if (!outcome) throw new Error(`no scripted outcome #${attempt} for task "${task}"`);
    return outcome;
  },
};

// ---------------------------------------------------------------------------
// Fold the declaration into the runtime table, check it, then mount it.

const host = new SimHost(world);
const store = createStore<RepoKeeperState>({ ...initialRepoKeeperDomain, goal: null });
const grants = new Map<string, GoalDispatch>();
const declare = declareRepoKeeperGoal(store, grants);

const table = declareGoalTable(declare);
store.set((state) => initGoalState(table, state));

const machineIR = lowerGoalToMachine(table, { id: REPO_KEEPER_GOAL_ID });
const diagnostics = analyzeGoal(table);

console.log(
  `goal "${REPO_KEEPER_GOAL_ID}" folded from ${Object.keys(table.edges).length} <phase> declarations`,
);
console.log("\nruntime transition table (plain data — the whole machine, no xstate):");
console.log(JSON.stringify(table, null, 2));
console.log("\ndev-time XState IR (events namespaced <phase>.<outcome>; @xstate/graph + Stately only):");
console.log(JSON.stringify(machineIR, null, 2));
console.log(
  `\nstatic checks (analyzeGoal): ${
    diagnostics.length === 0
      ? "clean — every phase reachable, done reachable, no dead ends, no dangling edges"
      : diagnostics.map((d) => `\n  [${d.code}] ${d.message}`).join("")
  }`,
);

const transitions: GoalTransition[] = [];
const onTransition = (transition: GoalTransition) => {
  transitions.push(transition);
  const tick = `t=${String(host.t).padStart(2)}`;
  const source = `${transition.source.phase}[${transition.source.child ?? "-"}]`;
  console.log(
    transition.changed
      ? `${tick}  ${source} ${transition.outcome} ▶ ${transition.to}`
      : `${tick}  ${source} ${transition.outcome} ⊘ ignored (${transition.ignored}) — the goal is at "${transition.from}"`,
  );
};

console.log("\n— mount: the initial phase's children spawn —");
const agent = mountAgent(
  <GoalProvider table={table} store={store} onTransition={onTransition}>
    {declare}
  </GoalProvider>,
  host,
);

for (let t = 1; t <= 16; t += 1) agent.tick();

// ---------------------------------------------------------------------------
// THE STALE DISPATCH. The verify worker's grant — minted for the `verify`
// phase — fires one more time after the goal has re-converged on `done`. The
// reducer refuses it: the event's source phase is not the current phase, so a
// late child callback can never spend another phase's vocabulary. Without
// source attribution this would have taken verify's `done` edge AGAIN.

console.log("\n— a late callback from the previous phase's child —");
const lateVerifyGrant = grants.get("verify/goal:verify")!;
agent.dispatch(() => lateVerifyGrant("done"));

// ---------------------------------------------------------------------------
// The vocabulary is closed: an outcome with no edge out of the current phase
// moves nothing either, and reports `unknown` rather than `stale`. Applied
// through the reducer, off the tree, to show this is a property of the table
// and not of the composition.

const persisted = store.get().goal!;
const stray = goalReducer(table, persisted, {
  type: "ship_it",
  source: { phase: persisted.phase },
});
console.log(
  `\nstray outcome "ship_it" from "${persisted.phase}" itself: changed=${stray.changed}, ignored=${stray.ignored}, phase stays "${stray.next.phase}"`,
);

console.log("\nfinal durable state:");
console.log(`  phase            ${store.get().goal!.phase}`);
console.log(`  lastSeenRelease  ${store.get().lastSeenRelease}`);
console.log(`  persisted goal   ${JSON.stringify(store.get().goal)}`);

console.log("\nCapability surface at rest (the goal is met, so only the watch remains):");
for (const key of (host.liveRecords as Map<string, unknown>).keys()) console.log(`  • ${key}`);

console.log("\n— unmount: desired state becomes ∅ —");
agent.unmount();

// ---------------------------------------------------------------------------
// The demo is a gate, not a printout.

const EXPECTED = [
  "assess[goal:assess] done ▶ plan",
  "plan[goal:plan] done ▶ upgrade",
  "upgrade[goal:upgrade] done ▶ verify",
  "verify[goal:verify] done ▶ done",
  "done[goal:releases] release_detected ▶ assess",
  "assess[goal:assess] done ▶ plan",
  "plan[goal:plan] done ▶ upgrade",
  "upgrade[goal:upgrade] done ▶ verify",
  "verify[goal:verify] failed ▶ repair",
  "repair[goal:repair] done ▶ upgrade",
  "upgrade[goal:upgrade] done ▶ verify",
  "verify[goal:verify] done ▶ done",
];

const actual = transitions
  .filter((transition) => transition.changed)
  .map(
    (transition) =>
      `${transition.source.phase}[${transition.source.child}] ${transition.outcome} ▶ ${transition.to}`,
  );

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[goal demo] ${message}`);
}

assert(diagnostics.length === 0, `expected a clean goal, got ${JSON.stringify(diagnostics)}`);
assert(
  JSON.stringify(actual) === JSON.stringify(EXPECTED),
  `transition log mismatch\n  expected ${JSON.stringify(EXPECTED, null, 2)}\n  actual   ${JSON.stringify(actual, null, 2)}`,
);
const ignored = transitions.filter((transition) => !transition.changed);
assert(
  ignored.length === 1 &&
    ignored[0]!.ignored === "stale" &&
    ignored[0]!.source.phase === "verify" &&
    ignored[0]!.from === "done",
  `expected exactly one stale-refused dispatch, got ${JSON.stringify(ignored)}`,
);
assert(!JSON.stringify(machineIR).includes('"final"'), "`done` must not lower to a final state");
assert(
  stray.changed === false && stray.ignored === "unknown",
  "an undeclared outcome must move nothing, and be told apart from a stale one",
);
assert(store.get().goal!.phase === "done", "the goal should have re-converged on done");

console.log(
  `\n✓ ${actual.length} transitions, exactly as scripted — including one regression out of done and one stale grant refused.`,
);
