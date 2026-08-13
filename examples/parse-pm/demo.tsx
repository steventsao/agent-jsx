/**
 * `bun examples/parse-pm/demo.tsx` — the parse PM end to end, offline. The
 * EXACT root component the worker executes (ParseAgent.spec.impl) mounted live
 * under React + SimHost, against the real ParseBench sample page and the real
 * unpdf extraction spec. No model is called: a scripted provider plays the
 * metered step with deterministic usage numbers.
 *
 * Five things to watch in the output:
 *
 *   1. THE PLAN IS A TABLE. ingest ▶ layout ▶ extract ▶ assemble ▶ verify ▶
 *      done — plus extract ⇄ paused as the budget gate — folded out of the
 *      `<Phase>` declarations, checked by analyzeGoal before anything mounts.
 *
 *   2. THE CHECKBOOK PAUSES THE MACHINE. With $0.025 and a $0.01 per-call
 *      ceiling, the PM affords title and authors (real usage: $0.017), then
 *      REFUSES abstract-left. Budget exhaustion is a PHASE: the machine parks
 *      at `paused` and the checkpoint records exactly which regions are paid.
 *
 *   3. CHECKPOINT BEFORE EXPENSIVE WORK. Every metered call is preceded by a
 *      durable persist of {phase, completedRegions+results, spend, calls} —
 *      the persist log printed below is the durability trace.
 *
 *   4. A LATE REPORT CANNOT CORRUPT THE MACHINE. While paused, the intro
 *      extractor's completion report arrives late (its grant was minted for
 *      the extract phase). The fold is refused and the dispatch lands in the
 *      log as `stale` — attribution, not trust.
 *
 *   5. TOP-UP RESUMES WITHOUT REWORK. The human gate raises the budget; the
 *      paused phase's gate task notices and dispatches `topped_up`; extract
 *      remounts ONLY the pending regions. The provider call log shows four
 *      calls total — title and authors are never re-bought — and the final
 *      segments equal the golden oracle.
 */

import { mountAgent } from "../../src/agent.ts";
import { SimHost, type World } from "../../src/sim-host.ts";
import { createStore } from "../../src/state.ts";
import { analyzeGoal } from "../goal/goal-dev.ts";
import { b64ToBytes, pageTextItems } from "../pdf/core/extract.ts";
import { SAMPLE_PDF_B64 } from "../../fixtures/pdf/sample-pdf.ts";
import { REGIONS } from "../../fixtures/pdf/regions.ts";
import golden from "../../fixtures/pdf/golden-segments.json";
import {
  applyTopUp,
  initialParsePmState,
  PARSE_GOAL_TABLE,
  PARSE_PM_ID,
  ParseAgent,
  type ParsePmState,
} from "./parse-agent.tsx";
import { playRegionExtractor } from "./drive.ts";
import { fakeProvider } from "./fake-provider.ts";
import { usd, type ParsePorts } from "./ports.ts";

// ---------------------------------------------------------------------------
// The PM's equipment. The doc lives in PM-OWNED storage (this holder stands in
// for DO storage) — never in state. The page parse happens ONCE, up front, so
// every region slice and the SimHost world stay synchronous.

const pmStorage: { doc: string | null } = { doc: null };
const pageItems = await pageTextItems(b64ToBytes(SAMPLE_PDF_B64));

const provider = fakeProvider();
const persistLog: Array<{ seq: number | null; reason: string | null }> = [];

const ports: ParsePorts = {
  ingest: () => {
    pmStorage.doc = SAMPLE_PDF_B64;
    return { bytes: pmStorage.doc.length };
  },
  layout: () => REGIONS,
  pageItems: () => pageItems,
  model: provider,
  persist: (state) => {
    const checkpoint = (state as ParsePmState).checkpoint;
    persistLog.push({ seq: checkpoint?.seq ?? null, reason: checkpoint?.reason ?? null });
  },
};

const world: World = {
  statusAt: () => 200,
  subagentLatency: 1,
  // The transport plays each extractor through EXACTLY its granted handlers.
  subagentResult: (record) => playRegionExtractor(record),
};

// ---------------------------------------------------------------------------
// Fold the declaration into the table, check it, then mount the real root.

const diagnostics = analyzeGoal(PARSE_GOAL_TABLE);
console.log(`goal "${PARSE_PM_ID}" folded from 7 <phase> declarations`);
console.log("\nruntime transition table (plain data — the structured plan):");
console.log(JSON.stringify(PARSE_GOAL_TABLE, null, 2));
console.log(
  `\nstatic checks (analyzeGoal): ${
    diagnostics.length === 0
      ? "clean — every phase reachable, done reachable, no dead ends, no dangling edges"
      : diagnostics.map((d) => `\n  [${d.code}] ${d.message}`).join("")
  }`,
);

const host = new SimHost(world);
const store = createStore<ParsePmState>({ ...initialParsePmState, budgetUsd: 0.025 });

let printed = 0;
const printTransitions = () => {
  for (const entry of store.get().log.slice(printed)) {
    const source = `${entry.source.phase}[${entry.source.child ?? "-"}]`;
    console.log(
      entry.changed
        ? `t=${String(host.t).padStart(2)}  ${source} ${entry.outcome} ▶ ${entry.to}  ($${entry.spentUsd.toFixed(3)} spent, ${entry.completed} done)`
        : `t=${String(host.t).padStart(2)}  ${source} ${entry.outcome} ⊘ ignored (${entry.ignored}) — the goal is at "${entry.from}"`,
    );
  }
  printed = store.get().log.length;
};

console.log("\n— mount: budget $0.025, ceiling $0.010/call —");
const agent = mountAgent(<ParseAgent.spec.impl store={store} ports={ports} />, host);

agent.tick(); // t=1 ingest task → layout
printTransitions();
agent.tick(); // t=2 layout task → extract mounts 4 extractors
printTransitions();

// Capture intro's record BEFORE the budget pause tears the phase down — the
// stand-in for a slow child whose completion report arrives late.
const introRecord = host.liveRecords.get("subagent:extract:intro-left");
if (!introRecord) throw new Error("[parse-pm demo] intro-left extractor should be mounted");
const lateText = String(introRecord.handlers.readRegion?.());
const lateReport = introRecord.handlers.onExtracted;

agent.tick(); // t=3 plays: title ✓, authors ✓, abstract-left REFUSED → paused
printTransitions();
agent.tick(); // t=4 topup gate checks the unchanged checkbook: still short
printTransitions();

const paused = store.get();
console.log("\n— the machine is PARKED, not crashed —");
console.log(`  phase        ${paused.goal!.phase}`);
console.log(`  spent        $${paused.spentUsd.toFixed(3)} of $${paused.budgetUsd.toFixed(3)} (${paused.callCount} calls)`);
console.log(`  refused at   ${paused.refusals[0]?.regionId} (ceiling $${paused.refusals[0]?.ceilingUsd.toFixed(3)} > remaining $${paused.refusals[0]?.remainingUsd.toFixed(3)})`);
console.log(`  checkpoint   #${paused.checkpoint!.seq} ${paused.checkpoint!.reason} — paid regions: [${paused.checkpoint!.completedRegions.join(", ")}]`);

console.log("\n— a late completion report from the extract phase, while paused —");
agent.dispatch(() =>
  lateReport?.({ regionId: "intro-left", text: lateText, label: "body-text", costUsd: 0 }),
);
printTransitions();

console.log("\n— the human gate: top up +$0.025 (the worker's bearer-guarded POST /topup) —");
agent.dispatch(() => applyTopUp(store, 0.025));
for (let i = 0; i < 5; i += 1) {
  agent.tick();
  printTransitions();
}

const final = store.get();
console.log("\nfinal durable state:");
console.log(`  phase      ${final.goal!.phase}`);
console.log(`  spent      $${final.spentUsd.toFixed(3)} of $${final.budgetUsd.toFixed(3)} (${final.callCount} calls)`);
console.log(`  ledger     ${final.ledger.map((entry) => entry.regionId).join(" → ")}`);
console.log(`  verified   ${JSON.stringify(final.verified)}`);
console.log(`  checkpoint #${final.checkpoint!.seq} (${final.checkpoint!.reason} @ ${final.checkpoint!.regionId})`);
console.log(
  `  persists   ${persistLog.length} durable writes: ${persistLog
    .map((entry) => `#${entry.seq}:${entry.reason === "budget-refused" ? "refused" : "pre-call"}`)
    .join(" ")}`,
);

console.log("\nCapability surface at rest (done mounts nothing):");
const liveSubagents = [...host.liveRecords.values()].filter((r) => r.kind === "subagent");
console.log(liveSubagents.length === 0 ? "  ∅" : liveSubagents.map((r) => `  • ${r.name}`).join("\n"));

console.log("\n— unmount: desired state becomes ∅ —");
agent.unmount();

// ---------------------------------------------------------------------------
// The demo is a gate, not a printout.

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[parse-pm demo] ${message}`);
}

const EXPECTED = [
  "ingest[task:ingest] ingested ▶ layout",
  "layout[task:layout] layouted ▶ extract",
  "extract[extractor:abstract-left] budget_exhausted ▶ paused",
  "paused[human:topup] topped_up ▶ extract",
  "extract[extractor:intro-left] extracted ▶ assemble",
  "assemble[task:assemble] assembled ▶ verify",
  "verify[task:verify] verified ▶ done",
];
const applied = final.log
  .filter((entry) => entry.changed)
  .map((entry) => `${entry.source.phase}[${entry.source.child}] ${entry.outcome} ▶ ${entry.to}`);

assert(diagnostics.length === 0, `expected a clean goal, got ${JSON.stringify(diagnostics)}`);
assert(
  JSON.stringify(applied) === JSON.stringify(EXPECTED),
  `transition log mismatch\n  expected ${JSON.stringify(EXPECTED, null, 2)}\n  actual   ${JSON.stringify(applied, null, 2)}`,
);
const refused = final.log.filter((entry) => !entry.changed);
assert(
  refused.length === 1 &&
    refused[0]!.ignored === "stale" &&
    refused[0]!.source.phase === "extract" &&
    refused[0]!.source.child === "extractor:intro-left" &&
    refused[0]!.from === "paused",
  `expected exactly one stale-refused late report, got ${JSON.stringify(refused)}`,
);

// Budget: paused at the exact boundary, resumed without rework.
assert(paused.goal!.phase === "paused", "the checkbook should park the machine at paused");
assert(
  JSON.stringify(paused.checkpoint!.completedRegions) === JSON.stringify(["title", "authors"]),
  `pause checkpoint should record exactly the paid regions, got ${JSON.stringify(paused.checkpoint)}`,
);
assert(paused.spentUsd === 0.017 && paused.callCount === 2, "pause spend should be $0.017 over 2 calls");
assert(
  JSON.stringify(provider.calls.map((call) => call.regionId)) ===
    JSON.stringify(["title", "authors", "abstract-left", "intro-left"]),
  `resume must not re-buy completed regions; provider saw ${JSON.stringify(provider.calls)}`,
);
assert(final.spentUsd === 0.03 && final.callCount === 4, "final spend should be $0.030 over 4 calls");
assert(
  persistLog.length === 5 && persistLog.filter((entry) => entry.reason === "budget-refused").length === 1,
  `expected 5 durable checkpoint writes (4 pre-call + 1 refusal), got ${JSON.stringify(persistLog)}`,
);

// Privacy: the doc never crossed a boundary and never entered state.
const stateJson = JSON.stringify(final);
assert(!stateJson.includes(SAMPLE_PDF_B64.slice(0, 64)), "pdf bytes must never enter durable state");

// The oracle: assembled segments equal golden, in region order.
for (const goldenSegment of golden as Array<{ id: string; text: string }>) {
  const entry = final.assembled!.find((candidate) => candidate.id === goldenSegment.id);
  assert(
    entry !== undefined && entry.text === goldenSegment.text,
    `segment ${goldenSegment.id} must equal the golden oracle`,
  );
}
assert(final.verified!.ok === true, "the verify phase should confirm the assembly");
assert(final.goal!.phase === "done", "the goal should rest at done");
assert(liveSubagents.length === 0, "done must mount no children");

console.log(
  `\n✓ ${applied.length} transitions exactly as scripted — one budget pause with a durable checkpoint, one stale late report refused, zero re-bought regions, segments equal golden.`,
);
