/**
 * The verification agent — Steven's Surge-AI "verification relationship" composed
 * as agent-jsx LIFECYCLE, the exact shape uptime-agent.tsx uses for outages:
 *
 *   uptime:        a site goes DOWN → mount an investigator + escalation tool
 *   verification:  a page's two witnesses DISAGREE → mount a reviewer + escalation tool
 *
 * The relationship, end to end:
 *   two independent witnesses per page (a VLM read + a deterministic text-layer
 *   read) → a per-page AGREEMENT score → a confidence GATE → contested pages mount
 *   a human REVIEW capability whose verdict OVERRIDES the model → pages the reviewer
 *   cannot reconcile route FAIL-CLOSED to exceptions[] → when agreement is restored
 *   (a verdict lands), the review capability UNMOUNTS.
 *
 * The human-review capability is DERIVED STATE: it exists for exactly the contested
 * pages and vanishes the moment each is settled. Nothing imperative spawns or
 * cancels a reviewer — it's all prop/state changes, same as the uptime loop.
 *
 * BRIGHT LINE: render is pure declaration (no LLM calls, no effects). The only
 * "execution" is the reviewer subagent completing in the host and the scripted
 * oracle it consults — both off the render path.
 */

import { useAgentState, type AgentStore } from "../src/state.ts";
import { Reviewer, type ReviewVerdict } from "./reviewer.tsx";

/** One page read by two independent witnesses. */
export interface PageWitness {
  pageId: string;
  /** VLM page-image read: fraction of the page's numbers recovered. */
  vlmNumberCoverage: number;
  /** Deterministic text-layer read: fraction of the page's numbers recovered. */
  textNumberCoverage: number;
  sourceNumbers?: number;
}

export interface VerifyState extends Record<string, unknown> {
  /** pageId → human-accepted number coverage (the reviewer's payload; overrides witnesses). */
  adjudicated: Record<string, number>;
  /** pages whose review has returned (resolved OR fail-closed) — settles the page. */
  reviewed: string[];
  /** pages routed fail-closed: the reviewer could not reconcile the witnesses. */
  exceptions: string[];
}

export const initialVerifyState: VerifyState = { adjudicated: {}, reviewed: [], exceptions: [] };

/** Two witnesses fused into one per-page agreement score in [0,1]. */
export const witnessAgreement = (p: PageWitness): number =>
  1 - Math.abs(p.textNumberCoverage - p.vlmNumberCoverage);

export interface VerificationAgentProps {
  pages: PageWitness[];
  store: AgentStore<VerifyState>;
  /** The scripted human-review oracle (stand-in for a real reviewer/queue). */
  reviewOracle: (pageId: string) => ReviewVerdict;
  /** Confidence GATE: witnesses that disagree by more than this (in number
   *  coverage) are contested. 0.30 = a 30-point coverage gap between the two reads. */
  disagreeMax?: number;
}

export function VerificationAgent({
  pages,
  store,
  reviewOracle,
  disagreeMax = 0.3,
}: VerificationAgentProps) {
  const { adjudicated, reviewed, exceptions } = useAgentState(store);

  const settled = (id: string) => reviewed.includes(id);
  const contested = pages.filter((p) => !settled(p.pageId) && witnessAgreement(p) < 1 - disagreeMax);

  // Applied when a reviewer subagent completes: the reviewer's SUBMITTED verdict
  // wins. Idempotent — a re-fire (or a post-hibernation re-arm) never double-applies.
  const applyVerdict = (id: string) => () => {
    const verdict = reviewOracle(id);
    store.set((s) => {
      if (s.reviewed.includes(id)) return s;
      if (verdict.resolved && verdict.acceptedCoverage != null) {
        // Reviewer payload OVERRIDES both witnesses.
        return {
          ...s,
          reviewed: [...s.reviewed, id],
          adjudicated: { ...s.adjudicated, [id]: verdict.acceptedCoverage },
        };
      }
      // FAIL-CLOSED: an unresolved page is quarantined, never silently accepted.
      return { ...s, reviewed: [...s.reviewed, id], exceptions: [...s.exceptions, id] };
    });
  };

  return (
    <>
      {/* Human-review capability = derived state: exactly the contested pages
          carry a reviewer; it disappears the instant agreement is restored. */}
      {contested.map((p) => (
        <Reviewer
          key={p.pageId}
          name={`review:page-${p.pageId}`}
          page={p.pageId}
          vlm={p.vlmNumberCoverage}
          text={p.textNumberCoverage}
          onResult={applyVerdict(p.pageId)}
          adjudicate={reviewOracle}
        />
      ))}

      {/* The escalation tool exists ONLY while a dispute is open. */}
      {contested.length > 0 && (
        <tool
          name="escalate-exception"
          description="Quarantine a page whose two witnesses cannot be reconciled (fail-closed)"
          run={() => "quarantined"}
        />
      )}

      {/* A STANDING capability: the batch acceptance gate, always present. */}
      <schedule name="acceptance-gate" every={6} onFire={() => {}} />

      <prompt>
        <sys p={10}>
          Verification agent over {pages.length} pages, two independent witnesses each (a VLM read
          and a deterministic text-layer read). Accept a page only when its witnesses agree or a
          human has adjudicated it; never accept an unresolved page.
        </sys>
        {contested.map((p) => (
          <msg key={p.pageId} p={9}>
            CONTESTED {p.pageId}: witnesses disagree — VLM cov={p.vlmNumberCoverage.toFixed(2)}, text
            cov={p.textNumberCoverage.toFixed(2)} (agreement {witnessAgreement(p).toFixed(2)}). Human
            review mounted.
          </msg>
        ))}
        {exceptions.map((id) => (
          <msg key={id} p={8}>
            EXCEPTION {id}: review unresolved — routed to exceptions[] (fail-closed, not accepted).
          </msg>
        ))}
        {pages.map((p, i) => (
          <msg key={p.pageId} prel={-i - 1}>
            history: {p.pageId}{" "}
            {settled(p.pageId) && !exceptions.includes(p.pageId)
              ? `accepted (adjudicated cov=${(adjudicated[p.pageId] ?? 0).toFixed(2)})`
              : "pending"}
            .
          </msg>
        ))}
      </prompt>
    </>
  );
}
