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

/** [row_start, row_end, col_start, col_end], inclusive — engines.py D7. */
type Span = [number, number, number, number];

interface TableProvenance {
  grid: [number, number];
  cell_count: number;
  /** Only cells covering MORE than one position; see reference.py. */
  merged: { span: Span; text: string }[];
}

interface ReferenceMeta {
  page: { sha256: string; size: [number, number]; dpi: number };
  layout: {
    detected: number;
    figures_dropped: number;
    ocr_regions: number;
    table_regions: number;
  };
  crops: Record<string, { sha256: string; box: number[] }>;
  tables: Record<string, TableProvenance>;
}

/** The committed PubTabNet ground truth. Used for PROVENANCE assertions and a
 *  REPORTED accuracy number — never as an equality gate; see the GT block. */
interface PubtabnetGt {
  filename: string;
  shape: [number, number];
  grid: string[][];
  spans: Span[];
  cells: string[];
  merged_cell_count: number;
  image: { sha256: string; size: [number, number]; served_asset_sha256: string };
  provenance: { hf_dataset: string; offset: number; key: string; fetched: string };
  licenses: { annotation: string; image: { pmc_id: string; oa_service_license: string } };
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
    mergedCells: 0,
  },
  {
    key: "table" as const,
    label: "p32 (text + table, no figure)",
    output: "reference-output-table.json",
    meta: "reference-meta-table.json",
    figuresDropped: 0,
    tableRegions: 1,
    phrase: "Matryoshka",
    /** p32's table is a plain 12x5 grid — no merge, hence the third page. */
    mergedCells: 0,
  },
  {
    key: "pubtabnet" as const,
    label: "PubTabNet PMC5343394 (table with MERGED cells)",
    output: "reference-output-pubtabnet.json",
    meta: "reference-meta-pubtabnet.json",
    figuresDropped: 0,
    tableRegions: 1,
    phrase: "Narcotics",
    /** THE point of this page: D7's span repetition finally has a golden. */
    mergedCells: 10,
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

  it("repeats every merged cell into EVERY position its span covers (rule D7)", () => {
    // D7's span half, checked against the model's OWN pre-placement output
    // rather than against ground truth: `meta.tables[].merged` records each
    // cell the model placed across more than one grid position, and the golden
    // must show that text at every one of them. Nothing here is an accuracy
    // claim — it is the mapping being verified instead of trusted.
    let mergedSeen = 0;
    for (const s of reference.segments.filter((x) => x.tag === "table")) {
      const rows = s.rows!;
      const prov = meta.tables[s.id];
      expect(prov).toBeDefined();
      expect(prov!.grid).toEqual([rows.length, rows[0]?.length ?? 0]);

      for (const { span, text } of prov!.merged) {
        const [r0, r1, c0, c1] = span;
        expect(r1).toBeGreaterThanOrEqual(r0);
        expect(c1).toBeGreaterThanOrEqual(c0);
        expect(r1 > r0 || c1 > c0).toBe(true); // genuinely merged, not 1x1
        expect(r1).toBeLessThan(rows.length);
        expect(c1).toBeLessThan(rows[0]!.length);
        for (let r = r0; r <= r1; r += 1) {
          for (let c = c0; c <= c1; c += 1) {
            // The whole rule: repeated, never a hole, never a ragged row.
            expect(rows[r]![c]).toBe(text);
          }
        }
        mergedSeen += 1;
      }
    }
    expect(mergedSeen).toBe(page.mergedCells);
  });
});

// ===========================================================================
// GROUND TRUTH — reported, never gated.
//
// SLANet does not reproduce PubTabNet's ground truth and is not asked to. This
// block therefore asserts only PROVENANCE (that the golden really was produced
// from the licensed fixture) and PRINTS accuracy. Turning any number below into
// an assertion would make an unrelated model upgrade look like a regression in
// the composition — and the composition is the only thing under test here. The
// equality gate remains reference ≡ composition, and nothing else.

const GT_FILE = join("fixtures", "pubtabnet-PMC5343394_003_00.gt.json");

/** Collapse whitespace and case before comparing a recognized cell to GT: the
 *  question is whether the same content landed in the same place, not whether
 *  the OCR spaced it identically. */
const normCell = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

const isMerged = ([r0, r1, c0, c1]: Span): boolean => r1 > r0 || c1 > c0;

/**
 * Layout may frame the table differently from PubTabNet's own crop — on this
 * fixture DocLayout-YOLO clips the narrow leading "S. No" column — so a
 * position-wise comparison has to say which GT columns the model actually saw.
 * The offset is SEARCHED rather than hard-coded so the number cannot be quietly
 * tuned, and the winning offset is printed alongside the score.
 */
function bestAlignment(model: string[][], gtGrid: string[][]) {
  const mCols = model[0]?.length ?? 0;
  const gCols = gtGrid[0]?.length ?? 0;
  let best: { offset: number; hits: number; total: number; pct: number } | null = null;
  for (let offset = 0; offset <= Math.max(0, gCols - mCols); offset += 1) {
    let hits = 0;
    let total = 0;
    for (let r = 0; r < gtGrid.length; r += 1) {
      for (let c = 0; c < mCols; c += 1) {
        total += 1;
        if (normCell(model[r]?.[c] ?? "") === normCell(gtGrid[r]?.[c + offset] ?? "")) {
          hits += 1;
        }
      }
    }
    // `>=` on the first candidate only: a zero-agreement alignment is still a
    // real measurement and must be reported, not collapse into a zeroed record.
    if (best === null || hits > best.hits) {
      best = { offset, hits, total, pct: total ? (100 * hits) / total : 0 };
    }
  }
  return best ?? { offset: 0, hits: 0, total: 0, pct: 0 };
}

describe("hybrid ground truth — PubTabNet PMC5343394 (reported, not gated)", () => {
  const reference = readJson<{ segments: Segment[] }>("reference-output-pubtabnet.json");
  const meta = readJson<ReferenceMeta>("reference-meta-pubtabnet.json");
  const gt = readJson<PubtabnetGt>(GT_FILE);

  it("the golden was produced from the licensed fixture, not a lookalike", () => {
    // Ties three files together: the raster the licence covers, the page the
    // oracle rendered, and the annotation accuracy is reported against.
    expect(meta.page.sha256).toBe(gt.image.sha256);
    expect(meta.page.size).toEqual(gt.image.size);
    expect(gt.filename).toBe("PMC5343394_003_00.png");
    expect(gt.licenses.image.pmc_id).toBe("PMC5343394");
    expect(gt.licenses.image.oa_service_license).toContain("CC BY");
    expect(gt.licenses.annotation).toContain("CDLA-Permissive-1.0");
    expect(gt.provenance.hf_dataset).toBe("nhhsag12/pubtabnet-with-html");
    expect(gt.provenance.offset).toBe(263);
  });

  it("the fixture actually carries merged cells — otherwise it proves nothing", () => {
    // A guard on the FIXTURE, not the model: if a future re-fetch landed on a
    // table without merges, D7 would silently stop being exercised again.
    expect(gt.merged_cell_count).toBeGreaterThan(0);
    expect(gt.spans.filter(isMerged)).toHaveLength(gt.merged_cell_count);
    expect(meta.tables.r0!.merged.length).toBeGreaterThan(0);
  });

  it("REPORTS cell agreement and span structure against ground truth", () => {
    const rows = reference.segments.find((s) => s.tag === "table")!.rows!;
    const align = bestAlignment(rows, gt.grid);

    const gtMerged = gt.spans.filter(isMerged);
    // Model spans live in the frame layout gave it; shift them back into GT
    // column space by the same offset before comparing geometry.
    const modelMerged = meta.tables.r0!.merged.map(
      ({ span: [r0, r1, c0, c1] }) =>
        `${r0},${r1},${c0 + align.offset},${c1 + align.offset}`,
    );
    const gtKeys = new Set(gtMerged.map((s) => s.join(",")));
    const matched = modelMerged.filter((k) => gtKeys.has(k));

    console.log(
      [
        "",
        "  PubTabNet GT agreement (REPORTED — not an assertion)",
        `    fixture          ${gt.filename}  ${gt.image.size.join("x")}  (PMC5343394, CC BY 4.0)`,
        `    GT grid          ${gt.shape.join("x")}, ${gtMerged.length} merged cells`,
        `    model grid       ${rows.length}x${rows[0]?.length ?? 0}, ${modelMerged.length} merged cells`,
        `    frame offset     ${align.offset} GT column(s) — layout clipped the leading "S. No" column`,
        `    cell agreement   ${align.pct.toFixed(1)}%  (${align.hits}/${align.total} exact, whitespace/case-insensitive)`,
        `    span geometry    ${matched.length}/${modelMerged.length} model spans match a GT span exactly`,
        "",
      ].join("\n"),
    );

    // The only assertion here is that the report is well-formed — every number
    // above is descriptive. Structure being grossly wrong would show up as a
    // near-zero agreement, which is a fixture-selection problem, not a failure
    // of the composition.
    expect(align.total).toBeGreaterThan(0);
    expect(modelMerged.length).toBeGreaterThan(0);
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
async function liveRun(which: "sample" | "table" | "pubtabnet"): Promise<LiveRun> {
  const cached = CACHE.get(which);
  if (cached) return cached;

  const { createHybridEngines, renderSamplePage, renderTablePage, loadPubtabnetPage } =
    await import("../examples/hybrid/engines.ts");

  // The PubTabNet input is already a raster, so it is LOADED rather than
  // rendered — the committed PNG is the page in both phases, byte for byte.
  const { page, sha256: pageSha } =
    which === "table"
      ? renderTablePage()
      : which === "pubtabnet"
        ? loadPubtabnetPage()
        : renderSamplePage();
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
      "the COMPOSITION's own grid repeats every merged cell across its span (D7)",
      async () => {
        // The always-on version of this checks the committed golden; this one
        // checks what the composition actually built this run. It is the half
        // that proves the span-repetition path RUNS inside Phase B rather than
        // being replayed from a file — on p1 there is no table at all, on p32 a
        // table with no merges, and here 10 rowspan=2 cells that must appear in
        // both of their rows.
        const { segments } = await liveRun(page.key);
        let mergedSeen = 0;
        for (const seg of segments.filter((s) => s.tag === "table")) {
          const rows = seg.rows!;
          for (const { span, text } of meta.tables[seg.id]!.merged) {
            const [r0, r1, c0, c1] = span;
            expect(r1 > r0 || c1 > c0).toBe(true);
            for (let r = r0; r <= r1; r += 1) {
              for (let c = c0; c <= c1; c += 1) expect(rows[r]![c]).toBe(text);
            }
            mergedSeen += 1;
          }
          // Every row the same width: the repetition rule exists precisely so
          // a span leaves no hole and no short row.
          expect(new Set(rows.map((r) => r.length)).size).toBe(rows.length ? 1 : 0);
        }
        expect(mergedSeen).toBe(page.mergedCells);
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
