/**
 * HYBRID OCR REPRODUCTION — Phase A ≡ Phase B, same models, same input.
 *
 * The PDF-PIPELINE.md methodology applied to a real hybrid OCR stack:
 *
 *   Phase A  scripts/hybrid/reference.py       hand-written imperative script
 *   Phase B  examples/hybrid/hybrid-pipeline   the composition grammar
 *
 * Both call the SAME three real models through the SAME engines.py:
 *   layout : DocLayout-YOLO  (juliozhao/DocLayout-YOLO-DocStructBench,
 *            doclayout_yolo_docstructbench_imgsz1024.pt, arXiv 2410.12628)
 *   ocr    : RapidOCR 1.4.4  (PP-OCRv4 ONNX, CPU, arXiv 2009.09941)
 *   table  : RapidTable 3.0.2 / SLANet-plus (PP-Structure ONNX, CPU)
 *
 * on TWO pages of the same arXiv paper:
 *   sample  fixtures/pdf/sample-pdf.ts        p1  — 12 text + 1 figure, NO table
 *   table   scripts/hybrid/fixtures/…pdf      p32 — 9 text + 1 table, no figure
 *
 * The second page exists because a page without a table cannot prove the
 * table branch runs. It is not a softer test: it is the same equality bar on
 * a page whose dispatch reaches a different specialist.
 *
 * Phase A is the oracle. Phase B must reproduce it EXACTLY — `toEqual` on the
 * whole segments array, no normalization, no tolerance, no rounding applied at
 * comparison time (all rounding happens once, inside engines.py, in both
 * paths). If this test ever needs a normalization step, the normalization
 * belongs in this comment and nowhere else. As of now there is none.
 *
 * The live half needs the models on disk and takes ~3min (one short-lived
 * python process per capability call, model load included — a live child
 * agent would pay that too), so it is gated:
 *
 *   HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx
 *
 * The ungated half validates both committed oracles' shape so ordinary CI
 * notices if either reference-output drifts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mountAgent } from "../src/agent.ts";
import { SimHost, type World } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import type { InfraRecord } from "../src/types.ts";
import {
  assembleSegments,
  HybridPipeline,
  idOrder,
  initialHybridState,
  type HybridState,
  type Region,
  type Segment,
} from "../examples/hybrid/hybrid-pipeline.tsx";

const HYBRID_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "scripts", "hybrid");
const readJson = <T,>(name: string): T =>
  JSON.parse(readFileSync(join(HYBRID_DIR, name), "utf8")) as T;

interface ReferenceMeta {
  page: { sha256: string; size: [number, number]; dpi: number };
  layout: {
    detected: number;
    figures_dropped: number;
    ocr_regions: number;
    table_regions: number;
  };
  crops: Record<string, { sha256: string; box: number[] }>;
}

const LIVE = !!process.env.HYBRID_REPRO;

/** The two pages under test, and what each is supposed to prove. */
const PAGES = [
  {
    key: "sample" as const,
    label: "p1 (text + figure, no table)",
    output: "reference-output.json",
    meta: "reference-meta.json",
    figuresDropped: 1,
    tableRegions: 0,
    /** a phrase the page's text must contain — guards against blank OCR */
    phrase: "Visual Document Retrieval",
  },
  {
    key: "table" as const,
    label: "p32 (text + table, no figure)",
    output: "reference-output-table.json",
    meta: "reference-meta-table.json",
    figuresDropped: 0,
    tableRegions: 1,
    phrase: "Matryoshka",
  },
];

// ===========================================================================
// Always on — both committed oracles' shape. Cheap, no models, no python.

// A plain loop rather than `describe.each`: bun 1.2.12 does not interpolate
// `$label` into the suite title, and both pages must be nameable in a failure.
for (const page of PAGES)
  describe(`hybrid oracle — committed reference ${page.label}`, () => {
  const reference = readJson<{ segments: Segment[] }>(page.output);
  const meta = readJson<ReferenceMeta>(page.meta);

  it("is a non-empty segment list with the pipeline's row shape", () => {
    expect(Array.isArray(reference.segments)).toBe(true);
    expect(reference.segments.length).toBeGreaterThan(0);
    for (const s of reference.segments) {
      // Exactly one payload key, chosen by tag — never both, never neither.
      if (s.tag === "table") {
        expect(Object.keys(s).sort()).toEqual(["bbox", "id", "rows", "tag"]);
        expect(Array.isArray(s.rows)).toBe(true);
      } else {
        expect(Object.keys(s).sort()).toEqual(["bbox", "id", "tag", "text"]);
        expect(typeof s.text).toBe("string");
      }
      expect(Object.keys(s.bbox).sort()).toEqual(["x0", "x1", "y0", "y1"]);
    }
  });

  it("carries no figure regions — figures have no text layer and are dropped", () => {
    expect(reference.segments.some((s) => s.tag === "figure")).toBe(false);
    expect(meta.layout.figures_dropped).toBe(page.figuresDropped);
    expect(reference.segments).toHaveLength(meta.layout.ocr_regions);
  });

  it("has the expected number of table regions", () => {
    expect(reference.segments.filter((s) => s.tag === "table")).toHaveLength(
      page.tableRegions,
    );
    expect(meta.layout.table_regions).toBe(page.tableRegions);
  });

  it("has unique ids in numeric order (r10 after r9, not after r1)", () => {
    const ids = reference.segments.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => idOrder(a) - idOrder(b)));
  });

  it("has normalized top-left bboxes rounded to 4 places (engines.py rule D4)", () => {
    for (const { bbox } of reference.segments) {
      for (const v of [bbox.x0, bbox.y0, bbox.x1, bbox.y1]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(Number(v.toFixed(4))).toBe(v);
      }
      expect(bbox.x0).toBeLessThan(bbox.x1);
      expect(bbox.y0).toBeLessThan(bbox.y1);
    }
  });

  it("recognized real content from the real page, not blanks", () => {
    const joined = reference.segments
      .map((s) => (s.tag === "table" ? (s.rows ?? []).flat().join(" ") : s.text))
      .join(" ");
    expect(joined).toContain(page.phrase);
  });

  it("every table is a rectangular, non-degenerate grid (engines.py rule D7)", () => {
    for (const s of reference.segments.filter((x) => x.tag === "table")) {
      const rows = s.rows!;
      expect(rows.length).toBeGreaterThan(1);
      const widths = new Set(rows.map((r) => r.length));
      expect(widths.size).toBe(1); // rectangular — spans repeat, never hole
      expect([...widths][0]).toBeGreaterThan(1);
      for (const cell of rows.flat()) {
        expect(typeof cell).toBe("string");
        expect(cell).toBe(cell.trim()); // D7 whitespace rule already applied
      }
      // Not a grid of blanks.
      expect(rows.flat().filter((c) => c.length > 0).length).toBeGreaterThan(
        rows.length,
      );
    }
  });
});

describe("hybrid assembly — the deterministic <task> body", () => {
  const bbox = { x0: 0, y0: 0, x1: 1, y1: 1 };
  const regions: Region[] = [
    { id: "r10", tag: "text", bbox, score: 0.9 },
    { id: "r2", tag: "figure", bbox, score: 0.9 },
    { id: "r1", tag: "text", bbox, score: 0.9 },
  ];

  it("drops figures, keeps {id,tag,bbox,text}, orders ids numerically", () => {
    expect(assembleSegments(regions, { r1: "one", r10: "ten" })).toEqual([
      { id: "r1", tag: "text", bbox, text: "one" },
      { id: "r10", tag: "text", bbox, text: "ten" },
    ]);
  });

  it("treats an empty recognition as a completed segment, not a hole", () => {
    expect(assembleSegments([regions[2]!], { r1: "" })).toEqual([
      { id: "r1", tag: "text", bbox, text: "" },
    ]);
  });

  it("emits rows (and NO text key) for a table region", () => {
    const withTable: Region[] = [
      { id: "r0", tag: "text", bbox, score: 0.9 },
      { id: "r1", tag: "table", bbox, score: 0.9 },
    ];
    const out = assembleSegments(withTable, { r0: "para" }, { r1: [["a", "b"]] });
    expect(out).toEqual([
      { id: "r0", tag: "text", bbox, text: "para" },
      { id: "r1", tag: "table", bbox, rows: [["a", "b"]] },
    ]);
    // `toEqual` ignores present-but-undefined keys, so assert absence directly.
    expect(Object.keys(out[1]!).sort()).toEqual(["bbox", "id", "rows", "tag"]);
    expect(Object.keys(out[0]!).sort()).toEqual(["bbox", "id", "tag", "text"]);
  });
});

// ===========================================================================
// Gated — the actual reproduction, with the actual models.

interface SeenChild {
  config: Record<string, unknown>;
  cropped?: string;
}

interface LiveRun {
  page: string;
  pageSha: string;
  segments: Segment[];
  regions: Region[];
  seen: Map<string, SeenChild>;
  creates: string[];
}

const CACHE = new Map<string, LiveRun>();

/** Drive the composition in SimHost with the REAL engines. The world plays
 *  each child's runtime by invoking exactly the capabilities its boundary
 *  granted (`record.handlers`) — the sim analog of a generated child pulling
 *  through its CallbackRef proxies. Nothing here reaches around the boundary
 *  to touch the page. */
async function liveRun(which: "sample" | "table"): Promise<LiveRun> {
  const cached = CACHE.get(which);
  if (cached) return cached;

  const { createHybridEngines, renderSamplePage, renderTablePage } = await import(
    "../examples/hybrid/engines.ts"
  );

  const { page, sha256: pageSha } =
    which === "table" ? renderTablePage() : renderSamplePage();
  const engines = createHybridEngines();
  const seen = new Map<string, SeenChild>();

  const world: World = {
    statusAt: () => 200,
    subagentLatency: 1,
    subagentResult: (record: InfraRecord) => {
      const kind = String(record.config.kind);
      const entry: SeenChild = { config: { ...record.config } };
      seen.set(record.name, entry);
      if (kind === "layout-detect") {
        return record.handlers.detectLayout?.(record.handlers.getPage?.() as string);
      }
      if (kind === "ocr-text") {
        entry.cropped = record.handlers.crop?.() as string;
        return {
          regionId: record.config.regionId,
          text: record.handlers.ocr?.(entry.cropped),
        };
      }
      if (kind === "parse-table") {
        entry.cropped = record.handlers.crop?.() as string;
        return {
          regionId: record.config.regionId,
          rows: record.handlers.parseTable?.(entry.cropped),
        };
      }
      throw new Error(`unexpected child kind ${kind}`);
    },
  };

  const host = new SimHost(world);
  const store = createStore<HybridState>({ ...initialHybridState, page });
  const agent = mountAgent(<HybridPipeline store={store} engines={engines} />, host, {
    quiet: true,
  });

  for (let i = 0; i < 12 && store.get().segments === null; i += 1) agent.tick();
  agent.unmount();

  const run: LiveRun = {
    page,
    pageSha,
    segments: store.get().segments ?? [],
    regions: store.get().regions ?? [],
    seen,
    creates: host.opLog
      .filter((op) => op.op === "create")
      .map((op) => `${op.kind}:${op.name}`),
  };
  CACHE.set(which, run);
  return run;
}

const TIMEOUT = 900_000;

// `describe.skipIf(...).each(...)` is not chainable in bun 1.2.12, so the gate
// is the inner describe.
for (const page of PAGES)
  describe(
    `hybrid reproduction — composition ≡ hand-written reference ${page.label}`,
    () => {
    const reference = readJson<{ segments: Segment[] }>(page.output);
    const meta = readJson<ReferenceMeta>(page.meta);

    describe.skipIf(!LIVE)("live", () => {
    it(
      "starts from byte-identical page pixels",
      async () => {
        // Equal sha256 here means any later difference is orchestration, not
        // input. For the sample page the two paths also reach the renderer
        // independently (Phase A through sample_pdf.py, Phase B through the
        // fixtures/pdf TS module); for the table page both open the same
        // committed one-page PDF.
        const { pageSha } = await liveRun(page.key);
        expect(pageSha).toBe(meta.page.sha256);
      },
      TIMEOUT,
    );

    it(
      "produces segments DEEP-EQUAL to the hand-written oracle",
      async () => {
        // THE ASSERTION. Whole array, exact strings, exact floats, exact
        // order, exact table grids. No normalization is applied — none is
        // needed, and none may be added.
        const { segments } = await liveRun(page.key);
        expect(segments).toEqual(reference.segments);
        // Deep-equality ignores present-but-undefined keys, so pin the exact
        // key set too: a table must not smuggle in an undefined `text`.
        expect(segments.map((s) => Object.keys(s).sort())).toEqual(
          reference.segments.map((s) => Object.keys(s).sort()),
        );
      },
      TIMEOUT,
    );

    it(
      "recognized byte-identical crops — attenuation yields the oracle's pixels",
      async () => {
        const { seen } = await liveRun(page.key);
        const { sha256OfB64 } = await import("../examples/hybrid/engines.ts");
        const { regions } = await liveRun(page.key);
        for (const [id, expected] of Object.entries(meta.crops)) {
          const tag = regions.find((r) => r.id === id)?.tag;
          const child = seen.get(`${tag === "table" ? "table" : "ocr"}:${id}`);
          expect(child?.cropped).toBeString();
          expect(sha256OfB64(child!.cropped!)).toBe(expected.sha256);
        }
      },
      TIMEOUT,
    );

    it(
      "dispatches each region to its OWN specialist and NONE for figures",
      async () => {
        const { creates, regions } = await liveRun(page.key);
        expect(creates).toContain("subagent:layout:page1");
        for (const r of regions) {
          const asText = creates.includes(`subagent:ocr:${r.id}`);
          const asTable = creates.includes(`subagent:table:${r.id}`);
          expect(asText).toBe(r.tag === "text");
          expect(asTable).toBe(r.tag === "table");
        }
        expect(new Set(creates).size).toBe(creates.length); // nothing twice
      },
      TIMEOUT,
    );

    it(
      "mounts exactly the table specialists the oracle says the page has",
      async () => {
        // The point of the second page: this count is 0 for p1 and 1 for p32,
        // so the branch is demonstrably reached rather than merely declared.
        const { seen } = await liveRun(page.key);
        const tableChildren = [...seen.entries()].filter(
          ([, c]) => c.config.kind === "parse-table",
        );
        expect(tableChildren).toHaveLength(page.tableRegions);
        expect(meta.layout.table_regions).toBe(page.tableRegions);
        for (const [name] of tableChildren) expect(name.startsWith("table:")).toBe(true);
      },
      TIMEOUT,
    );

    it(
      "never puts page bytes in a child's config — children pull, never receive",
      async () => {
        const { page: pageB64, seen } = await liveRun(page.key);
        expect(seen.size).toBeGreaterThan(1);
        const pageProbe = pageB64.slice(0, 96);
        for (const [name, child] of seen) {
          const serialized = JSON.stringify(child.config);
          expect(serialized).not.toContain(pageProbe);
          // A whole page raster is ~1MB of base64; a child's durable config is
          // its region id and kind. Size is the blunt version of the claim.
          expect(serialized.length).toBeLessThan(512);
          if (child.cropped) {
            expect(serialized).not.toContain(child.cropped.slice(0, 96));
          }
          expect(name).toBeString();
        }
      },
      TIMEOUT,
    );

    it(
      "the oracle bites: a shifted bbox cannot reproduce the golden segment",
      async () => {
        // Sanity that equality is load-bearing. Re-crop one region from a
        // deliberately wrong bbox through the SAME engine and confirm the
        // result differs from the oracle's for that region — for a text
        // region the string, for a table region the whole grid.
        const { page: pageB64 } = await liveRun(page.key);
        const { createHybridEngines } = await import("../examples/hybrid/engines.ts");
        const engines = createHybridEngines();
        const target =
          page.tableRegions > 0
            ? reference.segments.find((s) => s.tag === "table")!
            : reference.segments.find((s) => (s.text ?? "").length > 40)!;
        const shifted = {
          x0: target.bbox.x0,
          y0: Math.min(0.98, target.bbox.y0 + 0.12),
          x1: target.bbox.x1,
          y1: Math.min(0.99, target.bbox.y1 + 0.12),
        };
        const crop = engines.crop(pageB64, shifted);
        if (target.tag === "table") {
          expect(engines.table(crop)).not.toEqual(target.rows);
        } else {
          expect(engines.ocr(crop)).not.toBe(target.text);
        }
      },
      TIMEOUT,
    );
    });
  },
);
