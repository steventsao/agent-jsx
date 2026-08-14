/**
 * The demo goal: "keep this repo's dependencies fresh."
 *
 *   assess -> plan -> upgrade -> verify -> done
 *                        ^         |
 *                        |         v
 *                     repair <- failed
 *   done --release_detected--> assess          (a sensor, not a caller)
 *
 * THE VOCABULARY IS PHASE-LOCAL. Five phases all emit the same bare outcome —
 * `done` — and it means five different edges: assess.done -> plan,
 * plan.done -> upgrade, upgrade.done -> verify, verify.done -> done,
 * repair.done -> upgrade. The worker never knows which; it is a dumb
 * dispatcher, and the provider that minted its grant attributes the source.
 *
 * Two edges carry the whole argument for a reactive goal layer:
 *
 *   verify: failed  a phase can hand the goal BACKWARD. A linear workflow can
 *                   retry a step; it cannot re-enter an earlier one and remount
 *                   that phase's children with fresh grants.
 *
 *   done: release_detected  `done` is not the end. A sensor mounted by the
 *                   `done` phase notices upstream moved and knocks the goal
 *                   back to `assess`. There is no way to express "a finished
 *                   run un-finishes itself" inside a finished run — which is
 *                   why `done` is a regular phase with an outgoing edge.
 *
 * The children are deliberately dumb stubs: one authored function-component worker whose
 * only job is to report a bare outcome. No model is called anywhere in this example —
 * the point under test is the SUPERVISION, and a scripted SimHost world plays
 * the children's outcomes deterministically (see demo.tsx).
 */

import { result } from "../../src/agent-class.tsx";
import { Phase } from "../../src/agent-component.tsx";
import type { AgentStore } from "../../src/state.ts";
import { PhaseWorker } from "./generated/phase-worker.compiled.tsx";
import type { GoalApi, GoalDispatch, GoalOwnerState } from "./goal-provider.tsx";

export type { PhaseWorkerProps, PhaseWorkerState } from "./phase-worker.agent.tsx";

// ---------------------------------------------------------------------------
// The one child agent — authored as function + profile in
// ./phase-worker.agent.tsx and composed here through its compiler-owned
// companion (./generated/phase-worker.compiled.tsx) under the same public
// JSX name. Its props ARE its contract: the work it is executing, and the
// one line back out. NOTHING there knows the graph: no phase names, no edge
// maps, no global event vocabulary — just `dispatch(outcome)`.

// ---------------------------------------------------------------------------
// Durable state

export interface RepoKeeperState extends GoalOwnerState {
  /** Highest upstream release the goal has already reacted to. */
  lastSeenRelease: number;
}

export const initialRepoKeeperDomain = { lastSeenRelease: 1 };

export const REPO_KEEPER_GOAL_ID = "repo-keeper";

/** The registry the `done` phase watches. */
export const RELEASE_FEED = "https://registry.example/repo-keeper";

// ---------------------------------------------------------------------------
// The declaration — the single source of truth for BOTH the runtime table and
// what mounts. `declareGoalTable` evaluates exactly this function, so a phase
// that is analyzed is a phase that can mount, and vice versa.
//
// `grants`, when supplied, records every minted dispatch by `phase/child` — a
// demo/test seam for replaying a LATE callback (a grant whose phase the goal
// has since left) to show the reducer refusing it as stale.

export function declareRepoKeeperGoal(
  store: AgentStore<RepoKeeperState>,
  grants?: Map<string, GoalDispatch>,
) {
  return ({ dispatchFor }: GoalApi) => {
    const mint = (phase: string, child: string): GoalDispatch => {
      const dispatch = dispatchFor(phase, child);
      grants?.set(`${phase}/${child}`, dispatch);
      return dispatch;
    };
    // The watch's grant, minted for the `done` phase like any worker's.
    const reportRelease = mint("done", "goal:releases");

    return (
      <>
        <Phase name="assess" initial on={{ done: "plan" }}>
          <PhaseWorker name="goal:assess" task="assess" onOutcome={result(mint("assess", "goal:assess"))} />
        </Phase>

        <Phase name="plan" on={{ done: "upgrade" }}>
          <PhaseWorker name="goal:plan" task="plan" onOutcome={result(mint("plan", "goal:plan"))} />
        </Phase>

        <Phase name="upgrade" on={{ done: "verify" }}>
          <PhaseWorker name="goal:upgrade" task="upgrade" onOutcome={result(mint("upgrade", "goal:upgrade"))} />
        </Phase>

        <Phase name="verify" on={{ done: "done", failed: "repair" }}>
          <PhaseWorker name="goal:verify" task="verify" onOutcome={result(mint("verify", "goal:verify"))} />
        </Phase>

        <Phase name="repair" on={{ done: "upgrade" }}>
          <PhaseWorker name="goal:repair" task="repair" onOutcome={result(mint("repair", "goal:repair"))} />
        </Phase>

        {/* `done` mounts a WATCH, not a worker. The goal is met and stays met
            until the world says otherwise — which is the whole reason `done`
            has an outgoing edge and is a regular phase. The sensor's dispatch
            is minted for the `done` phase, so its report only counts while the
            goal is actually there. */}
        <Phase name="done" on={{ release_detected: "assess" }}>
          <sensor
            name="goal:releases"
            url={RELEASE_FEED}
            interval={2}
            onStatus={(release) => {
              // Loopy discipline: a poll that carries no news emits nothing.
              if (release <= store.get().lastSeenRelease) return;
              store.set((state) => ({ ...state, lastSeenRelease: release }));
              reportRelease("release_detected");
            }}
          />
        </Phase>
      </>
    );
  };
}
