/**
 * Root of the 3-level STATIC hierarchy (layout-analyst → layout-reviewer →
 * bbox-extractor). This mirrors flue's native shape exactly:
 *
 *   export default defineAgent(() => ({ ..., subagents: [layoutReviewer] }));
 *
 * where `layoutReviewer` is itself `defineAgentProfile({ ..., subagents: [bboxExtractor] })`.
 *
 * The impl ALWAYS renders <LayoutReviewer name="review:main" ...> — an
 * unconditional nested boundary, so it is STATIC infrastructure (present in
 * every render, at rest and under load). Nesting IS the spawn topology: the
 * analyst owns the reviewer, the reviewer owns its bbox extractors. The
 * compiler emits this as native `subagents:` arrays (flue) and one Durable
 * Object class per level whose childBinding reflects its own boundaries
 * (cloudflare) — no routing through a flat spawn plan.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { LayoutReviewer, type ReviewPage } from "./layout-reviewer.tsx";

export interface LayoutAnalystState extends Record<string, unknown> {
  /** The page to analyze; null at rest. Pushed in via applyState. */
  page: ReviewPage | null;
  /** The reviewer's folded-up verdict, once it reports. */
  verdict: string | null;
}

export const initialLayoutAnalystState: LayoutAnalystState = { page: null, verdict: null };

export const LayoutAnalyst = agentComponent<Record<string, never>, LayoutAnalystState>({
  agentName: "layout-analyst",
  initialState: initialLayoutAnalystState,
  impl: ({ store }) => {
    const { page, verdict } = useAgentState(store);
    return (
      <>
        {/* ALWAYS nested — the reviewer is the analyst's standing subagent.
            The page rides down as serializable props (null at rest); a verdict
            rides back up through the callback prop. */}
        <LayoutReviewer
          name="review:main"
          page={page}
          onVerdict={(v) => store.set({ verdict: v })}
        />

        <prompt>
          <sys p={10}>Analyze the document layout. Delegate review to the layout reviewer.</sys>
          <msg p={6}>{verdict ? `verdict: ${verdict}` : page ? "review in progress" : "waiting for a page"}</msg>
        </prompt>
      </>
    );
  },
});
