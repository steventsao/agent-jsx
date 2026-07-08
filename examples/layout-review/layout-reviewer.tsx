/**
 * Mid-level agent in the 3-level STATIC hierarchy (layout-analyst →
 * layout-reviewer → bbox-extractor).
 *
 * Its impl ALWAYS renders one <BboxExtractor> (the page header band, reviewed
 * on every page) — a STATIC nested boundary, present in every render. It ALSO
 * fans out one <BboxExtractor> per detected region — the DYNAMIC contrast,
 * gated on the `page` prop. Both nest the SAME reused leaf agent
 * (examples/pdf/bbox-extractor.tsx).
 *
 * The point this file makes: a child agent owns its OWN nested children. The
 * parent (layout-analyst) never sees these bbox extractors — it only knows it
 * nests a layout-reviewer. The compiler discovers this level transitively and
 * emits it as flue's native `subagents: [bboxExtractorProfile]` on the
 * layout-reviewer profile, plus a Durable Object class whose childBinding maps
 * bbox-extractor.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { BboxExtractor } from "../pdf/bbox-extractor.tsx";
import type { Bbox } from "../../targets/pdf/core/extract.ts";

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
  /** Line back to the parent: the review verdict once every region is read. */
  onVerdict: (verdict: string) => void;
}

export interface LayoutReviewerState extends Record<string, unknown> {
  segments: Record<string, string>;
}

/** The header band is reviewed on EVERY page regardless of detected regions —
 *  the always-on nested extractor (static hierarchy). */
const HEADER_BBOX: Bbox = { x0: 0, y0: 0, x1: 1, y1: 0.15 };

export const LayoutReviewer = agentComponent<LayoutReviewerProps, LayoutReviewerState>({
  agentName: "layout-reviewer",
  initialState: { segments: {} },
  sampleProps: { page: null, onVerdict: () => {} },
  impl: ({ page, onVerdict, store }) => {
    const { segments } = useAgentState(store);
    const regions = page?.regions ?? [];
    const fold = (id: string, text: string) =>
      store.set((s) => {
        const segs = { ...s.segments, [id]: text };
        // Report up once the header + every detected region is read.
        if (page && ["header", ...regions.map((r) => r.id)].every((k) => k in segs)) {
          onVerdict(`reviewed ${page.id}: ${Object.keys(segs).length} regions`);
        }
        return { ...s, segments: segs };
      });

    return (
      <>
        {/* STATIC nested boundary: the header extractor is ALWAYS present. */}
        <BboxExtractor
          name="bbox:main:header"
          regionId="header"
          bbox={HEADER_BBOX}
          getPdf={() => page?.pdfB64 ?? ""}
          onSegment={fold}
        />

        {/* DYNAMIC contrast: one nested extractor per detected region. Present
            only once the analyst has pushed a page with regions. */}
        {regions.map((region) => (
          <BboxExtractor
            key={region.id}
            name={`bbox:main:${region.id}`}
            regionId={region.id}
            bbox={region.bbox}
            getPdf={() => page?.pdfB64 ?? ""}
            onSegment={fold}
          />
        ))}

        <prompt>
          <sys p={10}>Review layout regions; delegate bbox extraction as needed.</sys>
          <msg p={6}>
            {regions.length} regions detected; {Object.keys(segments).length} read so far.
          </msg>
        </prompt>
      </>
    );
  },
});
