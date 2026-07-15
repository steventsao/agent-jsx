/**
 * The DYNAMIC half of the layout pipeline, expressed as CONTINUATION NESTING.
 *
 * The reviewer is the region DETECTOR: given a page it finds the layout regions
 * and EMITS their bounding boxes — `emit(regions)` from a one-shot <task>. It
 * spawns no children of its own. The call site (layout-analyst) owns the
 * continuation that maps those emitted boxes to one <BboxExtractor> each, so the
 * extractors are the ANALYST's direct children — not the reviewer's.
 *
 * `sampleOutput` is the representative emission the compiler expands the
 * continuation at, so `bbox-extractor` is discovered (its class/binding/profile
 * generated) even though the boundary is dynamic — output-gated, present only
 * once the reviewer has emitted.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import type { Bbox } from "../pdf/core/extract.ts";

export interface ReviewRegion {
  id: string;
  bbox: Bbox;
}

export interface ReviewPage {
  id: string;
  pdfB64: string;
  regions: ReviewRegion[];
}

export interface LayoutReviewerProps extends Record<string, unknown> {
  /** The page under review — pushed down from the analyst as serializable props. */
  page: ReviewPage | null;
}

export interface LayoutReviewerState extends Record<string, unknown> {
  /** Once the detection task has run and the regions have been emitted. */
  detected: boolean;
}

export const LayoutReviewer = agentComponent<LayoutReviewerProps, LayoutReviewerState, ReviewRegion[]>({
  agentName: "layout-reviewer",
  initialState: { detected: false },
  sampleProps: { page: null },
  // Representative emitted output — the compiler expands the parent's
  // continuation here so bbox-extractor is discovered at compile time.
  sampleOutput: [
    { id: "r1", bbox: { x0: 0, y0: 0.2, x1: 1, y1: 0.5 } },
    { id: "r2", bbox: { x0: 0, y0: 0.5, x1: 1, y1: 0.9 } },
  ],
  impl: ({ page, store, emit }) => {
    const { detected } = useAgentState(store);
    return (
      <>
        {/* Detect once per page, then emit the boxes back to the parent. The
            emitted output lands in the parent's reserved slot and drives its
            continuation — the reviewer spawns nothing itself. */}
        {page && !detected && (
          <task
            name={`detect:${page.id}`}
            run={async () => page.regions}
            onDone={(regions) => {
              store.set({ detected: true });
              emit?.(regions as ReviewRegion[]);
            }}
          />
        )}

        <prompt>
          <sys p={10}>Detect the layout regions of the page; emit their bounding boxes for extraction.</sys>
          <msg p={6}>
            {detected ? "regions emitted" : page ? "detecting regions…" : "waiting for a page"}
          </msg>
        </prompt>
      </>
    );
  },
});
