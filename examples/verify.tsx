/**
 * The verification relationship, PROVEN on real okra graphicbench data.
 *
 * Steven's Surge-AI claim, run end to end as agent-jsx lifecycle:
 *   two independent witnesses per page (VLM read + deterministic text-layer read)
 *   → per-page agreement → confidence gate → contested pages MOUNT a human reviewer
 *   whose verdict OVERRIDES the model → an unreconcilable page routes FAIL-CLOSED to
 *   exceptions[] → agreement restored ⇒ the review capability UNMOUNTS.
 *
 * Watch four things:
 *   1. `+ subagent review:page-…` appears for exactly the pages whose two
 *      witnesses disagree past the gate, and `- subagent …` when each is settled.
 *   2. `+ tool escalate-exception` exists ONLY while a dispute is open — the
 *      agent's capability surface is derived state.
 *   3. Hibernation MID-dispute → re-render the same code → every reviewer REBINDS,
 *      zero duplicate spawns (the "no duplicate capabilities on rehydrate" proof).
 *   4. Reviewer payloads OVERRIDE the weaker witness; the one page neither witness
 *      recovered is quarantined in exceptions[], never silently accepted.
 *
 * Fixture: examples/fixtures/graphicbench-witnesses.json — 8 chart pages from the
 * REAL okra run 2026-06-08-parse-html-parsebench-charts (text number-coverage avg
 * 0.869 vs VLM 0.617). Deterministic, offline, zero services, zero model calls.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import type { ReviewVerdict } from "./reviewer.tsx";
import {
  initialVerifyState,
  VerificationAgent,
  witnessAgreement,
  type PageWitness,
  type VerifyState,
} from "./verify-agent.tsx";

// ── real fixture ────────────────────────────────────────────────────────────
interface Fixture {
  _provenance: { sourceRun: string; aggregates: Array<{ system: string; numberCoverageAvg: number }> };
  pages: PageWitness[];
}
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/graphicbench-witnesses.json", import.meta.url)), "utf8"),
) as Fixture;
const PAGES = fixture.pages;

// ── the gate + the scripted human-review oracle ──────────────────────────────
const DISAGREE_MAX = 0.3; // contested when the two reads differ by > 30 points of number coverage
const NEAR_COMPLETE = 0.9; // a reviewer can only confirm a witness that recovered ≥ 90% of the page

/**
 * The reviewer's SUBMITTED verdict — deterministic scripted stand-in for a real
 * human reviewer/queue. Data-driven, not hand-picked:
 *   - if ONE witness is near-complete, the reviewer confirms it (the accepted
 *     value OVERRIDES the weaker witness — e.g. text 1.00 over VLM 0.25);
 *   - if NEITHER witness recovered the page, the witnesses cannot be reconciled
 *     against the source ⇒ unresolved ⇒ fail-closed to exceptions[].
 */
function buildReviewOracle(pages: PageWitness[]): (pageId: string) => ReviewVerdict {
  const byId = new Map(pages.map((p) => [p.pageId, p]));
  return (pageId) => {
    const p = byId.get(pageId)!;
    const best = Math.max(p.textNumberCoverage, p.vlmNumberCoverage);
    if (best >= NEAR_COMPLETE) {
      const winner = p.textNumberCoverage >= p.vlmNumberCoverage ? "text-layer" : "VLM";
      return {
        page: pageId,
        resolved: true,
        acceptedCoverage: best,
        note: `confirmed the ${winner} witness against the source page`,
      };
    }
    return {
      page: pageId,
      resolved: false,
      acceptedCoverage: null,
      note: "neither witness recovered the page; source ambiguous — quarantined",
    };
  };
}
const reviewOracle = buildReviewOracle(PAGES);

// SimHost world: reviews take 3 ticks to come back. No status polling — witnesses
// are given; the temporal dynamic is the review lifecycle.
const world = { subagentLatency: 3, statusAt: () => 200 };

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`\n✗ INVARIANT VIOLATED: ${msg}`);
    process.exit(1);
  }
}

// ── the fusion table (the gate firing on real data) ──────────────────────────
console.log(`verification relationship over ${PAGES.length} chart pages`);
console.log(`fixture: okra run ${fixture._provenance.sourceRun}`);
console.log(
  `aggregate number-coverage: ` +
    fixture._provenance.aggregates.map((a) => `${a.system} ${a.numberCoverageAvg}`).join("  vs  "),
);
console.log("\ntwo witnesses → agreement → gate:");
const expectedContested = PAGES.filter((p) => witnessAgreement(p) < 1 - DISAGREE_MAX);
for (const p of PAGES) {
  const agr = witnessAgreement(p);
  const gated = agr < 1 - DISAGREE_MAX;
  console.log(
    `  ${p.pageId.padEnd(30)} vlm=${p.vlmNumberCoverage.toFixed(2)} text=${p.textNumberCoverage.toFixed(2)}` +
      `  agreement=${agr.toFixed(2)}  ${gated ? "⚠ CONTESTED → review" : "✓ accept (witnesses agree)"}`,
  );
}
console.log(`\n${expectedContested.length}/${PAGES.length} pages contested; ${PAGES.length - expectedContested.length} accepted clean.`);

// ── process 1: the dispute opens, then the process dies mid-review ───────────
console.log("\n— process 1: gate fires → mount reviewers, then hibernate mid-review —");
const host1 = new SimHost(world);
const store1 = createStore<VerifyState>(initialVerifyState);
const agent1 = mountAgent(
  <VerificationAgent pages={PAGES} store={store1} reviewOracle={reviewOracle} disagreeMax={DISAGREE_MAX} />,
  host1,
);
agent1.tick(); // t=1
agent1.tick(); // t=2 — reviewers mounted, not yet returned (latency 3)

const BUDGET = 260;
console.log(`\n  — model turn at t=2 (context window under a ${BUDGET}-token budget) —`);
const rendered = agent1.prompt(BUDGET);
for (const b of rendered.included.filter((b) => b.priority >= 8))
  console.log(`    p=${b.priority} ${b.text.slice(0, 84)}${b.text.length > 84 ? "…" : ""}`);
console.log(`    context: ${rendered.usedTokens}/${BUDGET} tokens, ${rendered.excluded.length} routine-history blocks pruned`);

const infraSnapshot = host1.snapshot();
const stateSnapshot = store1.snapshot();
console.log(`\n  💾 persisted: infra=${infraSnapshot.length}B, state=${stateSnapshot.length}B (JSON only — no closures, no fiber tree)`);

// ── process 2: rehydrate → converge (no duplicate reviewers) ─────────────────
console.log("\n— process 2: restore + re-render the SAME code over persisted state —");
const host2 = SimHost.restore(infraSnapshot, world, 2);
const store2 = createStore<VerifyState>(JSON.parse(stateSnapshot));
const agent2 = mountAgent(
  <VerificationAgent pages={PAGES} store={store2} reviewOracle={reviewOracle} disagreeMax={DISAGREE_MAX} />,
  host2,
);
const dupes = host2.opLog.filter((o) => o.op === "create" || o.op === "remove");
console.log(
  dupes.length === 0
    ? `  ✓ converged: all ${host2.opLog.filter((o) => o.op === "rebind").length} records rebound, zero duplicate reviewers, zero spurious removes`
    : `  ✗ diverged: ${JSON.stringify(dupes)}`,
);
assert(dupes.length === 0, "rehydration must not duplicate or drop capabilities");

// ── process 2: the reviews land ──────────────────────────────────────────────
console.log("\n— reviews return: verdicts OVERRIDE the model; unreconcilable page → exceptions —");
for (let t = 3; t <= 6; t++) agent2.tick();

const final = store2.get();

console.log("\n  accepted after review (reviewer payload overrides the weaker witness):");
for (const p of PAGES) {
  if (final.adjudicated[p.pageId] === undefined) continue;
  console.log(
    `    ${p.pageId.padEnd(30)} vlm=${p.vlmNumberCoverage.toFixed(2)} text=${p.textNumberCoverage.toFixed(2)}` +
      ` → accepted ${final.adjudicated[p.pageId].toFixed(2)}  (${reviewOracle(p.pageId).note})`,
  );
}
console.log("\n  exceptions[] (fail-closed — never accepted):");
for (const id of final.exceptions) console.log(`    ${id}  (${reviewOracle(id).note})`);

// ── the capability surface after agreement is restored ───────────────────────
const liveKeys = [...(host2.liveRecords as Map<string, unknown>).keys()];
console.log("\n  standing capabilities after resolution:");
for (const k of liveKeys) console.log(`    • ${k}`);

// ── invariants (fail `bun run all` loudly if the relationship breaks) ─────────
const contestedIds = expectedContested.map((p) => p.pageId);
assert(final.reviewed.length === contestedIds.length, "every contested page must be settled by review");
assert(final.exceptions.length === 1, "exactly one page (recovered by neither witness) must fail closed");
assert(final.exceptions[0] === "the-beat-jun2025-p36", "the fail-closed page must be the one neither witness recovered");
assert(
  Object.keys(final.adjudicated).length === contestedIds.length - 1,
  "every resolvable contested page must carry an adjudicated override",
);
for (const p of expectedContested) {
  if (final.exceptions.includes(p.pageId)) continue;
  const accepted = final.adjudicated[p.pageId];
  const weaker = Math.min(p.vlmNumberCoverage, p.textNumberCoverage);
  assert(accepted > weaker, `accepted value for ${p.pageId} must override the weaker witness`);
}
assert(
  !liveKeys.some((k) => k.startsWith("subagent:review:") || k === "tool:escalate-exception"),
  "review + escalation capabilities must unmount once agreement is restored",
);
assert(
  liveKeys.includes("schedule:acceptance-gate"),
  "the standing acceptance gate must remain after the dispute clears",
);

console.log(
  `\n✓ relationship holds: ${PAGES.length - expectedContested.length} accepted clean · ` +
    `${contestedIds.length - 1} accepted after human override · 1 fail-closed exception · ` +
    `reviewers mounted only while contested, converged on rehydrate.`,
);
