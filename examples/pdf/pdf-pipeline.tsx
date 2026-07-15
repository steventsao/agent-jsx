/**
 * The React description of the Phase A parent: layout → per-bbox fan-out.
 *
 * State carries { pdfB64, regions, segments }. Loading a PDF (applyState /
 * runPipeline route) sets pdfB64 + regions (the layout step — fixture-driven
 * here, a live VLM later); the render fans out one <BboxExtractor> per
 * region; each child pulls the pdf via the getPdf method prop and folds its
 * text back through onSegment. `done` is derived: every region has a segment.
 *
 * Declared via `agentComponent(spec)` like every other agent — the spec (no
 * root props here, so no sampleProps) is what the compiler analyzes.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import type { Bbox } from "./core/extract.ts";
import { BboxExtractor } from "./bbox-extractor.tsx";

export interface Region {
  id: string;
  bbox: Bbox;
}

export interface PdfPipelineState extends Record<string, unknown> {
  pdfB64: string | null;
  regions: Region[];
  segments: Record<string, string>;
  /** Namespaces child DOs per run: task once-guards live in child state, so a
   *  fresh run must spawn fresh children (COMPAT-REPORT #31). */
  runId: string | null;
}

export const initialPdfPipelineState: PdfPipelineState = {
  pdfB64: null,
  regions: [],
  segments: {},
  runId: null,
};

export const PdfPipeline = agentComponent<Record<string, never>, PdfPipelineState>({
  agentName: "pdf-pipeline",
  initialState: initialPdfPipelineState,
  impl: ({ store }) => {
    const { pdfB64, regions, segments, runId } = useAgentState(store);
    // `=== undefined` on purpose: an empty-string extraction is a COMPLETED
    // segment (scanned/blank regions), not pending work. A truthiness check
    // here only looked safe because the child's once-guard cancelled the
    // re-fan-out (PARSEBENCH-RUN.md finding #4).
    const pending = regions.filter((r) => segments[r.id] === undefined);

    return (
      <>
        {pdfB64 &&
          runId &&
          pending.map((region) => (
            <BboxExtractor
              key={region.id}
              name={`extract:${runId}:${region.id}`}
              regionId={region.id}
              bbox={region.bbox}
              getPdf={() => store.get().pdfB64!}
              onSegment={(id, text) =>
                store.set((s) => ({ ...s, segments: { ...s.segments, [id]: text } }))
              }
            />
          ))}
        <prompt>
          <sys p={10}>
            PDF pipeline: layout gave {regions.length} regions; extract each region's text layer.
          </sys>
          {regions.map((r) => (
            <msg key={r.id} p={segments[r.id] ? 4 : 8}>
              {segments[r.id] ? `✓ ${r.id}: ${segments[r.id]!.slice(0, 60)}` : `… extracting ${r.id}`}
            </msg>
          ))}
        </prompt>
      </>
    );
  },
});
