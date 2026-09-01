/**
 * `bun examples/durable/demo.tsx` — the durable leaf under a goal, offline.
 *
 * The layering rule this demo exercises: JSX SUPERVISES, THE LEAF SEQUENCES.
 * The goal machine owns mounting, revocation, and regression; the imperative
 * workflow owns steps, checkpoints, and retries — and the split only works
 * because the leaf is exactly-once. Three things to watch:
 *
 *   1. THE LEAF RUNS ONCE, EVER. The goal passes through `upgrade` TWICE
 *      (verification fails the first time and `repair` hands the goal back),
 *      so the `<DurableRun>` record mounts twice. The second mount addresses
 *      the SAME durable execution — (workflow, payload) is the identity — and
 *      the engine REPLAYS the persisted result. The side-effect log stays at
 *      one entry while the goal happily converges.
 *
 *   2. A CRASH CHANGES NOTHING. Mid-goal, the process "dies": the SimHost is
 *      snapshotted and restored (only kind/name/config survive), while the
 *      ENGINE survives underneath — the role Durable Object storage plays in
 *      production. The rebooted composition rebinds handlers and the world
 *      re-arms the leaf; completed work replays instead of re-running.
 *
 *   3. EFFECT NEVER SURFACES. The workflow is authored as plain imperative
 *      TypeScript (`run(payload, step)` with `step.do` checkpoints — the
 *      Cloudflare Workflows shape); the composition is plain JSX. The Effect
 *      workflow engine (src/durable.ts) exists only INSIDE the executor.
 *
 * No model is called; every outcome is scripted, so the transcript is
 * deterministic and the demo is a gate, not a printout.
 */

import { mountAgent } from "../../src/agent.ts";
import { result } from "../../src/agent-class.tsx";
import { DurableRun } from "../../src/agent-component.tsx";
import { createDurableEngine, defineDurableWorkflow } from "../../src/durable.ts";
import { SimHost, type World } from "../../src/sim-host.ts";
import { createStore } from "../../src/state.ts";
import {
  declareGoalTable,
  GoalProvider,
  initGoalState,
  type GoalApi,
  type GoalOwnerState,
  type GoalTransition,
} from "../goal/goal-provider.tsx";

// ---------------------------------------------------------------------------
// The imperative leaf: authored as steps, checkpointed by the engine.

const sideEffects: string[] = [];

const UpgradeDeps = defineDurableWorkflow({
  name: "UpgradeDeps",
  run: async (payload: { pkg: string }, step) => {
    const version = await step.do("resolve", () => {
      sideEffects.push(`resolve ${payload.pkg}`);
      return "19.2.0";
    });
    return step.do("bump-lockfile", () => {
      sideEffects.push(`bump ${payload.pkg}@${version}`);
      return `${payload.pkg}@${version}`;
    });
  },
});

// ---------------------------------------------------------------------------
// The goal: upgrade -> verify -> done, with verify able to hand the goal
// BACKWARD through repair. Verification is scripted to fail once, so the
// upgrade phase — and its durable leaf — mounts twice.

interface DemoState extends GoalOwnerState {
  delivered: string[];
}

const VERIFY_SCRIPT = ["failed", "done"];
let verifyAttempt = 0;

const store = createStore<DemoState>({ delivered: [], goal: null });

const declare = ({ dispatchFor }: GoalApi) => {
  const upgradeDispatch = dispatchFor("upgrade", "run:upgrade");
  const verifyDispatch = dispatchFor("verify", "run:verify");
  const repairDispatch = dispatchFor("repair", "run:repair");
  return (
    <>
      <phase name="upgrade" initial on={{ done: "verify" }}>
        <DurableRun
          name="run:upgrade"
          workflow={UpgradeDeps}
          payload={{ pkg: "react" }}
          onResult={result((r: unknown) => {
            store.set((s) => ({ ...s, delivered: [...s.delivered, String(r)] }));
            upgradeDispatch("done", r);
          })}
        />
      </phase>
      <phase name="verify" on={{ done: "done", failed: "repair" }}>
        <task
          name="run:verify"
          run={() => VERIFY_SCRIPT[verifyAttempt++] ?? "done"}
          onDone={(outcome) => verifyDispatch(String(outcome))}
        />
      </phase>
      <phase name="repair" on={{ done: "upgrade" }}>
        <task name="run:repair" run={() => "done"} onDone={() => repairDispatch("done")} />
      </phase>
      <phase name="done" />
    </>
  );
};

// ---------------------------------------------------------------------------
// Fold, check, mount — then crash in the middle and keep going.

const table = declareGoalTable(declare);
store.set((state) => initGoalState(table, state));

const engine = createDurableEngine({ workflows: [UpgradeDeps] });
const world: World = { statusAt: () => 200, durable: engine };

const transitions: GoalTransition[] = [];
const onTransition = (transition: GoalTransition) => {
  transitions.push(transition);
  const source = `${transition.source.phase}[${transition.source.child ?? "-"}]`;
  console.log(
    transition.changed
      ? `  ${source} ${transition.outcome} ▶ ${transition.to}`
      : `  ${source} ${transition.outcome} ⊘ ignored (${transition.ignored})`,
  );
};

console.log(`goal folded from ${Object.keys(table.edges).length} <phase> declarations`);
console.log(`durable leaf: workflow "${UpgradeDeps.name}", identity = (workflow, payload)\n`);

console.log("— first pass: upgrade runs for real, verification fails —");
let host = new SimHost(world);
let agent = mountAgent(
  <GoalProvider table={table} store={store} onTransition={onTransition}>
    {declare}
  </GoalProvider>,
  host,
  { quiet: true },
);

// upgrade (durable leaf) → verify (fails) → repair.
for (let t = 0; t < 3; t += 1) {
  agent.tick();
  await host.settle();
}

console.log(`\n  side effects so far   ${JSON.stringify(sideEffects)}`);
console.log(`  goal is at            ${store.get().goal!.phase}`);

console.log("\n— the goal is back at upgrade when the process dies; records + the engine survive —");
const snapshot = host.snapshot();
agent.unmount();

host = SimHost.restore(snapshot, world, host.t);
agent = mountAgent(
  <GoalProvider table={table} store={store} onTransition={onTransition}>
    {declare}
  </GoalProvider>,
  host,
  { quiet: true },
);

console.log("— rebooted: the leaf re-arms into the SAME execution and REPLAYS —");
for (let t = 0; t < 4; t += 1) {
  agent.tick();
  await host.settle();
}
agent.unmount();
await engine.dispose();

console.log(`\nfinal phase        ${store.get().goal!.phase}`);
console.log(`deliveries         ${JSON.stringify(store.get().delivered)}`);
console.log(`side effects       ${JSON.stringify(sideEffects)}`);

// ---------------------------------------------------------------------------
// The demo is a gate, not a printout.

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[durable demo] ${message}`);
}

const applied = transitions
  .filter((t) => t.changed)
  .map((t) => `${t.source.phase} ${t.outcome} ▶ ${t.to}`);

assert(
  JSON.stringify(applied) ===
    JSON.stringify([
      "upgrade done ▶ verify",
      "verify failed ▶ repair",
      "repair done ▶ upgrade",
      "upgrade done ▶ verify",
      "verify done ▶ done",
    ]),
  `transition log mismatch: ${JSON.stringify(applied)}`,
);
assert(store.get().goal!.phase === "done", "the goal should converge on done");
assert(
  JSON.stringify(sideEffects) === JSON.stringify(["resolve react", "bump react@19.2.0"]),
  `the leaf must run its steps exactly once, got ${JSON.stringify(sideEffects)}`,
);
assert(
  JSON.stringify(store.get().delivered) ===
    JSON.stringify(["react@19.2.0", "react@19.2.0"]),
  "both mounts must deliver the SAME persisted result",
);

console.log(
  "\n✓ two passes through upgrade, one crash, one execution: the leaf ran once and replayed once.",
);
