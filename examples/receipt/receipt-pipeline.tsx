/**
 * Receipt cascade — the VLM + OCR composition pattern:
 *
 *   layout (VLM agent) → tag dispatch → per-region specialists on CROPS
 *   → deterministic assemble (<task>).
 *
 * The capability rules this example exists to demonstrate:
 *   - The page is never pushed into child props. The layout agent PULLS via a
 *     `getPage` method prop (the PDF-PIPELINE pattern); region parsers get a
 *     `crop` method prop ATTENUATED parent-side: zero-arg, closed over that
 *     region's bbox — a child cannot address pixels outside its region.
 *   - Engines (VLM, OCR, table model) are granted method props too — the
 *     deterministic fixtures in tests swap for live models without touching
 *     composition (PDF-PIPELINE: "a later swap that must not touch extraction").
 *   - Tag dispatch is parent-owned composition: `table` → TableParser,
 *     `text` → OcrText, `figure` → nothing mounts at all.
 *   - Each specialist reports through ONE result binding; assembly is plain
 *     deterministic code in a one-shot <task>, not an agent.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import type { AgentStore } from "../../src/state.ts";

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type RegionTag = "text" | "table" | "figure";

export interface Region {
  id: string;
  tag: RegionTag;
  bbox: Bbox;
}

/** The engine seams — deterministic in tests, live models in production. */
export interface ReceiptEngines {
  layout: (page: string) => Region[];
  ocr: (crop: string) => string;
  table: (crop: string) => string[][];
}

/** The demo "image" format: a JSON map of bbox-key → pixel content. `crop`
 *  derives strictly from (page, bbox) — the deterministic stand-in for real
 *  raster cropping. */
export const bboxKey = (b: Bbox) => [b.x0, b.y0, b.x1, b.y1].join(",");
export const cropImage = (page: string, bbox: Bbox): string =>
  (JSON.parse(page) as Record<string, string>)[bboxKey(bbox)] ?? "";

// ---------------------------------------------------------------------------
// LayoutParser — the VLM layout step. Pulls the page, grants nothing onward.

export interface LayoutParserProps {
  getPage: () => string;
  parseLayout: (page: string) => Region[];
  onRegions: (regions: Region[]) => void;
}

export const LayoutParser = agentComponent<LayoutParserProps, Record<string, never>>({
  agentName: "layout-parser",
  initialState: {},
  capabilities: {
    getPage: { kind: "method" },
    parseLayout: { kind: "method" },
    onRegions: { kind: "result" },
  },
  sampleProps: {
    getPage: () => "{}",
    parseLayout: () => [],
    onRegions: () => {},
  },
  impl: () => (
    <prompt>
      <sys p={10}>You segment one document page into tagged regions with bounding boxes.</sys>
    </prompt>
  ),
});

// ---------------------------------------------------------------------------
// OcrText — text specialist on ONE attenuated crop.

export interface OcrTextProps {
  regionId: string;
  /** Attenuated: zero-arg, bbox pre-bound by the parent. */
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
      <sys p={10}>You OCR the text of ONE cropped region ({regionId}).</sys>
    </prompt>
  ),
});

// ---------------------------------------------------------------------------
// TableParser — table-structure specialist on ONE attenuated crop.

export interface TableParserProps {
  regionId: string;
  crop: () => string;
  parseTable: (crop: string) => string[][];
  onTable: (result: { regionId: string; rows: string[][] }) => void;
}

export const TableParser = agentComponent<TableParserProps, Record<string, never>>({
  agentName: "table-parser",
  initialState: {},
  capabilities: {
    crop: { kind: "method" },
    parseTable: { kind: "method" },
    onTable: { kind: "result" },
  },
  sampleProps: {
    regionId: "sample",
    crop: () => "",
    parseTable: () => [],
    onTable: () => {},
  },
  impl: ({ regionId }) => (
    <prompt>
      <sys p={10}>You recover the row/cell structure of ONE cropped table ({regionId}).</sys>
    </prompt>
  ),
});

// ---------------------------------------------------------------------------
// ReceiptPipeline — the root reactive machine. Plain function component: the
// topmost component receives the source handle + engine capabilities + store;
// everything below gets only narrowed grants.

export interface Receipt {
  merchant: string;
  total: string;
  items: string[][];
}

export interface ReceiptState extends Record<string, unknown> {
  page: string | null;
  regions: Region[] | null;
  texts: Record<string, string>;
  tables: Record<string, string[][]>;
  receipt: Receipt | null;
}

export const initialReceiptState: ReceiptState = {
  page: null,
  regions: null,
  texts: {},
  tables: {},
  receipt: null,
};

/** Deterministic assembly — plain code, not an agent. */
export function assembleReceipt(regions: Region[], texts: Record<string, string>, tables: Record<string, string[][]>): Receipt {
  const textRegions = regions.filter((r) => r.tag === "text");
  const merchant = texts[textRegions[0]?.id ?? ""] ?? "";
  const totalLine = textRegions.map((r) => texts[r.id] ?? "").find((t) => t.includes("TOTAL")) ?? "";
  const total = totalLine.match(/\$[\d.]+/)?.[0] ?? "";
  const tableRegion = regions.find((r) => r.tag === "table");
  const items = tableRegion ? (tables[tableRegion.id] ?? []) : [];
  return { merchant, total, items };
}

export function ReceiptPipeline({ store, engines }: { store: AgentStore<ReceiptState>; engines: ReceiptEngines }) {
  const { page, regions, texts, tables, receipt } = useAgentState(store);

  const parseable = (regions ?? []).filter((r) => r.tag !== "figure");
  const pending = parseable.filter((r) =>
    r.tag === "table" ? tables[r.id] === undefined : texts[r.id] === undefined,
  );
  const allParsed = regions !== null && pending.length === 0;

  return (
    <>
      {page && !regions && (
        <LayoutParser
          name="layout:main"
          getPage={() => store.get().page!}
          parseLayout={engines.layout}
          onRegions={(rs) => store.set((s) => ({ ...s, regions: rs }))}
        />
      )}
      {page &&
        pending.map((region) =>
          region.tag === "table" ? (
            <TableParser
              key={region.id}
              name={`table:${region.id}`}
              regionId={region.id}
              crop={() => cropImage(store.get().page!, region.bbox)}
              parseTable={engines.table}
              onTable={({ regionId, rows }) =>
                store.set((s) => ({ ...s, tables: { ...s.tables, [regionId]: rows } }))
              }
            />
          ) : (
            <OcrText
              key={region.id}
              name={`ocr:${region.id}`}
              regionId={region.id}
              crop={() => cropImage(store.get().page!, region.bbox)}
              ocr={engines.ocr}
              onText={({ regionId, text }) =>
                store.set((s) => ({ ...s, texts: { ...s.texts, [regionId]: text } }))
              }
            />
          ),
        )}
      {allParsed && !receipt && (
        <task
          name="assemble"
          run={() => assembleReceipt(regions!, store.get().texts, store.get().tables)}
          onDone={(r) => store.set((s) => ({ ...s, receipt: r as Receipt }))}
        />
      )}
      <prompt>
        <sys p={10}>
          Receipt pipeline: {regions ? `${regions.length} regions` : "awaiting layout"};{" "}
          {receipt ? "assembled." : `${pending.length} region(s) parsing.`}
        </sys>
      </prompt>
    </>
  );
}
