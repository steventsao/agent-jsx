/**
 * PHASE B, half 2 — the hybrid OCR pipeline written in the composition
 * grammar instead of as a script.
 *
 * This is examples/receipt/receipt-pipeline.tsx's cascade with the fixtures
 * taken out and real models put in:
 *
 *   layout agent (DocLayout-YOLO) → tag dispatch → per-region specialists on
 *   ATTENUATED crops (RapidOCR) → deterministic assemble <task>.
 *
 * Nothing about the SHAPE changes when the engines become real. That is the
 * claim: the same declaration that ran on a JSON stand-in page runs on a
 * 1241x1754 raster of an arXiv paper, and produces exactly what the
 * hand-written Phase A script produces (scripts/hybrid/reference.py).
 *
 * The capability rules carried over verbatim from the receipt cascade:
 *   - The page raster is never pushed into a child's config. The layout agent
 *     PULLS it through `getPage`; region specialists never see it at all —
 *     they get `crop`, ATTENUATED parent-side to zero arguments with their own
 *     bbox closed over. A child cannot address a pixel outside its region.
 *   - Engines are method props, so swapping fixtures for live models is a
 *     change to the caller, not to this file.
 *   - Tag dispatch is parent-owned: `text` mounts OcrText; `figure` mounts
 *     NOTHING (a figure has no text layer, so the oracle never OCRs one);
 *     `table` is a declared-but-unreached branch on this input (see TODO).
 *   - Assembly is deterministic code in a one-shot <task>, not an agent.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import type { AgentStore } from "../../src/state.ts";
import type { Bbox, HybridEngines, Region } from "./engines.ts";

export type { Bbox, HybridEngines, Region };

/** One row of the equality object. Byte-shape of a `segments[]` entry in
 *  scripts/hybrid/reference-output.json. */
export interface Segment {
  id: string;
  tag: string;
  bbox: Bbox;
  text: string;
}

// ---------------------------------------------------------------------------
// LayoutDetect — the DocLayout-YOLO step. Pulls the page, grants nothing on.

export interface LayoutDetectProps {
  getPage: () => string;
  detectLayout: (page: string) => Region[];
  onRegions: (regions: Region[]) => void;
}

export const LayoutDetect = agentComponent<LayoutDetectProps, Record<string, never>>({
  agentName: "layout-detect",
  initialState: {},
  capabilities: {
    getPage: { kind: "method" },
    detectLayout: { kind: "method" },
    onRegions: { kind: "result" },
  },
  sampleProps: {
    getPage: () => "",
    detectLayout: () => [],
    onRegions: () => {},
  },
  impl: () => (
    <prompt>
      <sys p={10}>
        You segment one rendered document page into tagged regions with bounding boxes.
      </sys>
    </prompt>
  ),
});

// ---------------------------------------------------------------------------
// OcrText — text recognition on ONE attenuated crop.

export interface OcrTextProps {
  regionId: string;
  /** Attenuated: zero-arg, this region's bbox pre-bound by the parent. */
  crop: () => string;
  ocr: (crop: string) => string;
  onText: (result: { regionId: string; text: string }) => void;
}

export const OcrText = agentComponent<OcrTextProps, Record<string, never>>({
  agentName: "ocr-text",
  initialState: {},
  capabilities: {
    crop: { kind: "method" },
    ocr: { kind: "method" },
    onText: { kind: "result" },
  },
  sampleProps: {
    regionId: "sample",
    crop: () => "",
    ocr: () => "",
    onText: () => {},
  },
  impl: ({ regionId }) => (
    <prompt>
      <sys p={10}>You recognize the text of ONE cropped region ({regionId}).</sys>
    </prompt>
  ),
});

// ---------------------------------------------------------------------------
// HybridPipeline — the root reactive machine.

export interface HybridState extends Record<string, unknown> {
  /** base64 PNG of the rendered page. The only place page bytes live. */
  page: string | null;
  regions: Region[] | null;
  texts: Record<string, string>;
  segments: Segment[] | null;
}

export const initialHybridState: HybridState = {
  page: null,
  regions: null,
  texts: {},
  segments: null,
};

/**
 * `r10` sorts after `r9`. Identical rule to `id_order` in reference.py —
 * plain lexicographic ordering would put r10..r12 between r1 and r2 and the
 * two paths would disagree on ORDER while agreeing on CONTENT.
 */
export const idOrder = (id: string): number => {
  const m = /^r(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/** Deterministic assembly — plain code, not an agent. Mirrors reference.py
 *  step 5 exactly: figures are already gone, sort by numeric id, emit
 *  {id, tag, bbox, text}. */
export function assembleSegments(
  regions: Region[],
  texts: Record<string, string>,
): Segment[] {
  return regions
    .filter((r) => r.tag !== "figure")
    .map((r) => ({ id: r.id, tag: r.tag, bbox: r.bbox, text: texts[r.id] ?? "" }))
    .sort((a, b) => idOrder(a.id) - idOrder(b.id));
}

export function HybridPipeline({
  store,
  engines,
}: {
  store: AgentStore<HybridState>;
  engines: HybridEngines;
}) {
  const { page, regions, texts, segments } = useAgentState(store);

  // A figure carries no text layer: it is dropped here, so no specialist is
  // ever declared for it. This is the same filter as reference.py step 3 —
  // expressed as "nothing mounts" rather than as a list comprehension.
  const parseable = (regions ?? []).filter((r) => r.tag !== "figure");
  // `=== undefined` on purpose: an empty recognition is a COMPLETED segment,
  // not pending work (PARSEBENCH-RUN.md finding #4).
  const pending = parseable.filter((r) => texts[r.id] === undefined);
  const allParsed = regions !== null && pending.length === 0;

  return (
    <>
      {page && !regions && (
        <LayoutDetect
          name="layout:page1"
          getPage={() => store.get().page!}
          detectLayout={engines.layout}
          onRegions={(rs) => store.set((s) => ({ ...s, regions: rs }))}
        />
      )}
      {page &&
        pending.map((region) => (
          <OcrText
            key={region.id}
            name={`ocr:${region.id}`}
            regionId={region.id}
            // ATTENUATION: zero-arg, region.bbox closed over parent-side. The
            // child never learns the page, never names a bbox.
            crop={() => engines.crop(store.get().page!, region.bbox)}
            ocr={engines.ocr}
            onText={({ regionId, text }) =>
              store.set((s) => ({ ...s, texts: { ...s.texts, [regionId]: text } }))
            }
          />
        ))}
      {allParsed && !segments && (
        <task
          name="assemble"
          run={() => assembleSegments(regions!, store.get().texts)}
          onDone={(r) => store.set((s) => ({ ...s, segments: r as Segment[] }))}
        />
      )}
      <prompt>
        <sys p={10}>
          Hybrid OCR pipeline: {regions ? `${regions.length} regions` : "awaiting layout"};{" "}
          {segments ? `assembled ${segments.length} segments.` : `${pending.length} region(s) recognizing.`}
        </sys>
      </prompt>
    </>
  );
}
