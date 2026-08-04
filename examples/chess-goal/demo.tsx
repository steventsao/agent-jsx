/**
 * `bun examples/chess-goal/demo.tsx` — chess on the goal layer, end to end,
 * offline. The EXACT root component the deployed worker executes
 * (ChessGoalMatch.spec.impl) mounted live under React + SimHost.
 *
 * Five things to watch in the output:
 *
 *   1. THE RUNTIME IS A TABLE. The alternation white ⇄ black was not written
 *      as board code; it was folded out of the `<phase>` declarations:
 *      `edges[white][moved] -> black`, and both sides' `ended -> over`.
 *
 *   2. ALTERNATION IS PHASE-DRIVEN. Every hand-over in the op log is the
 *      provider unmounting one phase's seat and mounting the other's. The
 *      transition log shows ATTRIBUTION: `white[seat:white] moved ▶ black`
 *      means the seat only said "moved" — the provider that minted its grant
 *      knew the source phase and child.
 *
 *   3. AN ILLEGAL MOVE MOVES NOTHING. White's first scripted decision is
 *      illegal: the DOMAIN reducer refuses it (lastError), no outcome is
 *      dispatched, the SAME phase stays mounted, and the seat's turn context
 *      now carries lastError as the re-prompt. The host re-delivers (what the
 *      worker's next /step does) and the corrected move proceeds.
 *
 *   4. A STALE GRANT CANNOT CORRUPT THE MATCH. After checkmate ends the goal,
 *      a LATE callback from black's seat handler fires again — and is refused
 *      as stale, because its minted source phase is no longer current.
 *
 *   5. `over` IS AN ORDINARY PHASE. No children, no outgoing edges, nothing
 *      terminal by type: the capability surface at rest is empty.
 *
 * No model is called. A scripted SimHost world plays both seats (fool's mate),
 * so the entire transcript is deterministic.
 */

import { mountAgent } from "../../src/agent.ts";
import { SimHost, type World } from "../../src/sim-host.ts";
import { createStore } from "../../src/state.ts";
import { analyzeGoal } from "../goal/goal-dev.ts";
import {
  CHESS_GOAL_ID,
  CHESS_GOAL_TABLE,
  ChessGoalMatch,
  initialChessGoalState,
  type ChessGoalState,
} from "./match.tsx";

// ---------------------------------------------------------------------------
// The scripted world. White's opening decision is deliberately ILLEGAL; the
// corrected move is re-delivered by hand below, the way the worker's next
// /step re-delegates the same mounted seat. Then fool's mate.

const SCRIPT: Record<string, { move: string; note: string }> = {
  "white:0": { move: "e2e5", note: "an illegal lunge" },
  "black:1": { move: "e7e5", note: "mirrors the centre" },
  "white:2": { move: "g2g4", note: "opens the fatal diagonal" },
  "black:3": { move: "d8h4", note: "checkmate" },
};

const world: World = {
  statusAt: () => 200,
  subagentLatency: 1,
  subagentResult: (record) => SCRIPT[record.name] ?? { move: "0000", note: "off script" },
};

// ---------------------------------------------------------------------------
// Fold the declaration into the table, check it, then mount the real root.

const diagnostics = analyzeGoal(CHESS_GOAL_TABLE, { doneState: "over" });
console.log(`goal "${CHESS_GOAL_ID}" folded from 3 <phase> declarations`);
console.log("\nruntime transition table (plain data — the whole machine):");
console.log(JSON.stringify(CHESS_GOAL_TABLE, null, 2));
console.log(
  `\nstatic checks (analyzeGoal, over = met): ${
    diagnostics.length === 0
      ? "clean — every phase reachable, over reachable, no dangling edges"
      : diagnostics.map((d) => `\n  [${d.code}] ${d.message}`).join("")
  }`,
);

const host = new SimHost(world);
const store = createStore<ChessGoalState>(initialChessGoalState);

let printed = 0;
const printTransitions = () => {
  for (const entry of store.get().log.slice(printed)) {
    const source = `${entry.source.phase}[${entry.source.child ?? "-"}]`;
    const move = entry.san ? ` (${entry.san})` : "";
    console.log(
      entry.changed
        ? `t=${String(host.t).padStart(2)}  ${source} ${entry.outcome} ▶ ${entry.to}${move}`
        : `t=${String(host.t).padStart(2)}  ${source} ${entry.outcome} ⊘ ignored (${entry.ignored}) — the goal is at "${entry.from}"`,
    );
  }
  printed = store.get().log.length;
};

console.log("\n— mount: the initial phase's seat spawns —");
const agent = mountAgent(<ChessGoalMatch.spec.impl store={store} />, host);

// t=1: white:0 plays the ILLEGAL scripted move. Domain refuses; phase stays.
agent.tick();
printTransitions();
const whiteSeat = host.liveRecords.get("subagent:white:0");
if (!whiteSeat) throw new Error("[chess-goal demo] white:0 should still be mounted after an illegal move");
const illegalContext = (whiteSeat.config.turn as { lastError: string | null }).lastError;
console.log(`\nillegal move refused by the DOMAIN — phase stays "white", no dispatch.`);
console.log(`white:0 re-prompt context: ${JSON.stringify(illegalContext).slice(0, 88)}…`);

// The host re-delivers the seat's corrected decision (the worker's next /step).
console.log("\n— the host re-delivers white's corrected decision —");
agent.dispatch(() => whiteSeat.handlers.onTurn?.({ move: "f2f3", note: "corrected: a quiet blunder" }));
printTransitions();

// Stash black's routed handler mid-match so it can fire LATE after the end.
for (let t = 0; t < 2; t += 1) {
  agent.tick();
  printTransitions();
}
const lateBlackSeat = host.liveRecords.get("subagent:black:3");
if (!lateBlackSeat) throw new Error("[chess-goal demo] black:3 should be mounted before the mate");
const lateBlackOnTurn = lateBlackSeat.handlers.onTurn!;

agent.tick(); // t=4: black:3 delivers checkmate → ended ▶ over
printTransitions();

// ---------------------------------------------------------------------------
// THE STALE CALLBACK. Black's seat handler — granted for the black phase —
// fires once more after the goal reached `over`. The domain refuses to move
// (there is no turn), and the goal reducer refuses the dispatch as stale.

console.log("\n— a late callback from black's seat, after the match ended —");
agent.dispatch(() => lateBlackOnTurn({ move: "h4e1", note: "far too late" }));
printTransitions();

const final = store.get();
console.log("\nfinal durable state:");
console.log(`  status   ${final.status} (winner: ${final.winner})`);
console.log(`  moves    ${final.history.map((m) => m.san).join(" ")}`);
console.log(`  goal     ${JSON.stringify(final.goal)}`);
console.log(`  log      ${final.log.length} attributed transitions (${final.log.filter((e) => !e.changed).length} refused)`);

console.log("\nCapability surface at rest (over mounts nothing):");
const liveSubagents = [...host.liveRecords.values()].filter((r) => r.kind === "subagent");
console.log(liveSubagents.length === 0 ? "  ∅" : liveSubagents.map((r) => `  • ${r.name}`).join("\n"));

console.log("\n— unmount: desired state becomes ∅ —");
agent.unmount();

// ---------------------------------------------------------------------------
// The demo is a gate, not a printout.

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[chess-goal demo] ${message}`);
}

const EXPECTED = [
  "white[seat:white] moved ▶ black",
  "black[seat:black] moved ▶ white",
  "white[seat:white] moved ▶ black",
  "black[seat:black] ended ▶ over",
];
const applied = final.log
  .filter((entry) => entry.changed)
  .map((entry) => `${entry.source.phase}[${entry.source.child}] ${entry.outcome} ▶ ${entry.to}`);

assert(diagnostics.length === 0, `expected a clean goal, got ${JSON.stringify(diagnostics)}`);
assert(
  JSON.stringify(applied) === JSON.stringify(EXPECTED),
  `transition log mismatch\n  expected ${JSON.stringify(EXPECTED)}\n  actual   ${JSON.stringify(applied)}`,
);
assert(typeof illegalContext === "string" && illegalContext.includes("illegal move"),
  "the re-prompt context should carry the domain's lastError");
const refused = final.log.filter((entry) => !entry.changed);
assert(
  refused.length === 1 && refused[0]!.ignored === "stale" && refused[0]!.source.phase === "black" && refused[0]!.from === "over",
  `expected exactly one stale-refused dispatch, got ${JSON.stringify(refused)}`,
);
assert(final.status === "checkmate" && final.winner === "black", "fool's mate should end the match for black");
assert(final.goal!.phase === "over", "the goal should rest at over");
assert(liveSubagents.length === 0, "over must mount no seats");

console.log(
  `\n✓ ${applied.length} phase transitions, exactly as scripted — one illegal move held the phase, one stale grant refused.`,
);
