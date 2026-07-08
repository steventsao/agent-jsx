/**
 * The human-review capability, authored as a child agent component — the exact
 * shape investigator.tsx uses for outage investigation, here for page adjudication.
 *
 * A page whose two witnesses DISAGREE mounts one of these. Its props ARE its
 * contract:
 *   - page, vlm, text  — the contested page and its two witness readings.
 *     Serializable props → the child's input (compiled to setProps; a parent
 *     re-render that changes them updates the child).
 *   - onResult         — the adjudicated verdict flowing back up. Callback prop →
 *     compiled to RPC; the reviewer's payload is what the parent applies, and it
 *     OVERRIDES both witnesses (see verify-agent.tsx).
 *   - adjudicate       — METHOD PROP: the parent's scripted human-review oracle,
 *     granted to the child like any capability (mirrors investigator's
 *     `lookupRunbook`). In the COMPILED child the reviewer calls this itself and
 *     RPCs the verdict back; in the SIM the parent applies the same oracle when
 *     the review subagent completes — same verdict, same override.
 *
 * BRIGHT LINE: no LLM call lives in render or in an effect. The review "executes"
 * only when the child's own <schedule> (its SLA) fires — an event handler in the
 * host, never render. The tree here declares STANDING capabilities (the
 * reviewer's own tools, its SLA, its prompt); it never runs a model step.
 */

import { agentComponent } from "../src/agent-component.tsx";
import { useAgentState } from "../src/state.ts";

/** What a human reviewer submits. In a deterministic offline demo this is
 *  scripted test data standing in for a real reviewer/queue; the CONTROL FLOW
 *  (payload overrides the model; unresolved ⇒ fail-closed) is the point. */
export interface ReviewVerdict {
  page: string;
  /** true = the reviewer reconciled the witnesses and accepts a value. */
  resolved: boolean;
  /** The human-accepted number coverage. OVERRIDES both witnesses. null when unresolved. */
  acceptedCoverage: number | null;
  note: string;
}

export interface ReviewerProps extends Record<string, unknown> {
  page: string;
  vlm: number;
  text: number;
  onResult: (verdict: ReviewVerdict) => void | Promise<void>;
  /** METHOD PROP — the parent's scripted human-review oracle, awaited like a
   *  local function across the agent boundary (args + return structured-cloneable). */
  adjudicate: (page: string) => ReviewVerdict | Promise<ReviewVerdict>;
}

export interface ReviewerState extends Record<string, unknown> {
  pulledSource: boolean;
}

export const Reviewer = agentComponent<ReviewerProps, ReviewerState>({
  agentName: "reviewer",
  initialState: { pulledSource: false },
  sampleProps: {
    page: "sample-page",
    vlm: 0.6,
    text: 0.9,
    onResult: () => {},
    adjudicate: () => ({ page: "sample-page", resolved: true, acceptedCoverage: 0.9, note: "" }),
  },
  impl: ({ page, vlm, text, onResult, adjudicate, store }) => {
    const { pulledSource } = useAgentState(store);
    const disagreement = Math.abs(text - vlm);
    return (
      <>
        {/* The reviewer's OWN capability surface — never leaks into the parent. */}
        <tool
          name="pull-source-page"
          description="Fetch the source PDF page (image + text layer) for side-by-side adjudication"
          run={() => `source(${page})`}
        />
        {/* SLA: when it fires, consult the parent's human-review oracle (a method
            prop — RPC with a return value) and report the verdict back exactly once. */}
        <schedule
          name="review-sla"
          every={3}
          onFire={async () => {
            const verdict = await adjudicate(page);
            return onResult(verdict);
          }}
        />
        <prompt>
          <sys p={10}>
            You adjudicate ONE contested page: {page}. The VLM witness read number-coverage
            {" "}
            {vlm.toFixed(2)}; the text-layer witness read {text.toFixed(2)} (they disagree by
            {" "}
            {disagreement.toFixed(2)}). Decide the accepted value or mark it unresolvable.
          </sys>
          <msg p={7}>
            Source {pulledSource ? "pulled" : "not yet pulled"}. Your verdict overrides both witnesses.
          </msg>
          <msg prel={-1}>Playbook: pull source → compare both reads against it → accept or quarantine.</msg>
        </prompt>
      </>
    );
  },
});
