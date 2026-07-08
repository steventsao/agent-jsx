/**
 * Root of the layout pipeline, expressed with CONTINUATION NESTING — Steven's
 * target syntax verbatim (modulo the required `name` props):
 *
 *   <LayoutReviewer name="review:main" page={page}>
 *     {(boxes) => boxes.map((bbox) => (
 *       <BboxExtractor name={`bbox:${bbox.id}`} bbox={bbox} onSegment={…} />
 *     ))}
 *   </LayoutReviewer>
 *
 * The analyst spawns the reviewer (static, always present) and passes it a
 * function child — the CONTINUATION. The reviewer emits its detected boxes; the
 * emitted output lands in the analyst's reserved slot and the continuation
 * fans out one <BboxExtractor> per box. Those extractors are the analyst's OWN
 * direct children (parent spawns them, parent env binds them, their segments
 * fold back into analyst state) — grandchildren by topology, parent-owned by
 * ownership. The continuation is pure: it re-renders from persisted state, so
 * no closure ever serializes.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { LayoutReviewer, type ReviewPage } from "./layout-reviewer.tsx";
import { BboxExtractor } from "../pdf/bbox-extractor.tsx";

export interface LayoutAnalystState extends Record<string, unknown> {
  /** The page to analyze; null at rest. Pushed in via applyState. */
  page: ReviewPage | null;
  /** Extracted text per region, folded up from the bbox extractors. */
  segments: Record<string, string>;
  /** Verdict once every detected region is read. */
  verdict: string | null;
}

export const initialLayoutAnalystState: LayoutAnalystState = {
  page: null,
  segments: {},
  verdict: null,
};

export const LayoutAnalyst = agentComponent<Record<string, unknown>, LayoutAnalystState>({
  agentName: "layout-analyst",
  initialState: initialLayoutAnalystState,
  impl: ({ store }) => {
    const { page, segments, verdict } = useAgentState(store);

    const fold = (regionId: string, text: string) =>
      store.set((s) => {
        const segs = { ...s.segments, [regionId]: text };
        const expected = s.page?.regions.map((r) => r.id) ?? [];
        const complete = expected.length > 0 && expected.every((id) => id in segs);
        return {
          ...s,
          segments: segs,
          verdict: complete ? `reviewed ${s.page!.id}: ${expected.length} regions` : s.verdict,
        };
      });

    return (
      <>
        {/* The reviewer is the analyst's standing subagent (static). Its emitted
            boxes drive the continuation below — the extractors it maps are the
            analyst's own children, so the segments fold back into THIS state. */}
        <LayoutReviewer name="review:main" page={page}>
          {(boxes) =>
            boxes.map((bbox) => (
              <BboxExtractor
                key={bbox.id}
                name={`bbox:${bbox.id}`}
                regionId={bbox.id}
                bbox={bbox.bbox}
                getPdf={() => page?.pdfB64 ?? ""}
                onSegment={fold}
              />
            ))
          }
        </LayoutReviewer>

        <prompt>
          <sys p={10}>
            Analyze the document layout. Delegate detection to the reviewer; extract each region it emits.
          </sys>
          <msg p={6}>
            {verdict
              ? `verdict: ${verdict}`
              : page
                ? `review in progress (${Object.keys(segments).length} regions read)`
                : "waiting for a page"}
          </msg>
        </prompt>
      </>
    );
  },
});
