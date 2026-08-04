/**
 * HYBRID OCR REPRODUCTION — Phase A ≡ Phase B, same models, same input.
 *
 * The PDF-PIPELINE.md methodology applied to a real hybrid OCR stack:
 *
 *   Phase A  scripts/hybrid/reference.py       hand-written imperative script
 *   Phase B  examples/hybrid/hybrid-pipeline   the composition grammar
 *
 * Both call the SAME two real models through the SAME engines.py:
 *   layout : DocLayout-YOLO  (juliozhao/DocLayout-YOLO-DocStructBench,
 *            doclayout_yolo_docstructbench_imgsz1024.pt, arXiv 2410.12628)
 *   ocr    : RapidOCR 1.4.4  (PP-OCRv4 ONNX, CPU, arXiv 2009.09941)
 * on the SAME input (fixtures/pdf/sample-pdf.ts, the ParseBench arXiv page).
 *
 * Phase A is the oracle. Phase B must reproduce it EXACTLY — `toEqual` on the
 * whole segments array, no normalization, no tolerance, no rounding applied at
 * comparison time (all rounding happens once, inside engines.py, in both
 * paths). If this test ever needs a normalization step, the normalization
 * belongs in this comment and nowhere else.
 *
 * The live half needs the models on disk and takes ~90s (one short-lived
 * python process per capability call, model load included — a live child
 * agent would pay that too), so it is gated:
 *
 *   HYBRID_REPRO=1 bun test tests/hybrid-repro.test.tsx
 *
 * The ungated half validates the committed oracle's shape so ordinary CI
 * notices if reference-output.json drifts.
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
  layout: { detected: number; figures_dropped: number; ocr_regions: number };
  crops: Record<string, { sha256: string; box: number[] }>;
}

const LIVE = !!process.env.HYBRID_REPRO;

// ===========================================================================
// Always on — the committed oracle's shape. Cheap, no models, no python.

describe("hybrid oracle — committed reference output", () => {
  const reference = readJson<{ segments: Segment[] }>("reference-output.json");
  const meta = readJson<ReferenceMeta>("reference-meta.json");

  it("is a non-empty segment list with the pipeline's row shape", () => {
    expect(Array.isArray(reference.segments)).toBe(true);
    expect(reference.segments.length).toBeGreaterThan(0);
    for (const s of reference.segments) {
      expect(Object.keys(s).sort()).toEqual(["bbox", "id", "tag", "text"]);
      expect(typeof s.text).toBe("string");
      expect(Object.keys(s.bbox).sort()).toEqual(["x0", "x1", "y0", "y1"]);
    }
  });

  it("carries no figure regions — figures have no text layer and are dropped", () => {
    expect(reference.segments.some((s) => s.tag === "figure")).toBe(false);
    expect(meta.layout.figures_dropped).toBeGreaterThan(0); // the drop actually happened
    expect(reference.segments).toHaveLength(meta.layout.ocr_regions);
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

  it("recognized real text from the real page, not blanks", () => {
    const joined = reference.segments.map((s) => s.text).join(" ");
    expect(joined).toContain("Visual Document Retrieval");
    expect(reference.segments.filter((s) => s.text.length > 40).length).toBeGreaterThan(4);
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

let CACHED: LiveRun | null = null;

/** Drive the composition in SimHost with the REAL engines. The world plays
 *  each child's runtime by invoking exactly the capabilities its boundary
 *  granted (`record.handlers`) — the sim analog of a generated child pulling
 *  through its CallbackRef proxies. Nothing here reaches around the boundary
 *  to touch the page. */
async function liveRun(): Promise<LiveRun> {
  if (CACHED) return CACHED;

  const { createHybridEngines, renderSamplePage } = await import(
    "../examples/hybrid/engines.ts"
  );

  const { page, sha256: pageSha } = renderSamplePage();
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

  CACHED = {
    page,
    pageSha,
    segments: store.get().segments ?? [],
    regions: store.get().regions ?? [],
    seen,
    creates: host.opLog
      .filter((op) => op.op === "create")
      .map((op) => `${op.kind}:${op.name}`),
  };
  return CACHED;
}

const TIMEOUT = 900_000;

describe.skipIf(!LIVE)("hybrid reproduction — composition ≡ hand-written reference", () => {
  const reference = readJson<{ segments: Segment[] }>("reference-output.json");
  const meta = readJson<ReferenceMeta>("reference-meta.json");

  it(
    "starts from byte-identical page pixels",
    async () => {
      // The two paths reach the renderer independently (Phase A through
      // sample_pdf.py, Phase B through the fixtures/pdf TS module). Equal
      // sha256 here means any later difference is orchestration, not input.
      const { pageSha } = await liveRun();
      expect(pageSha).toBe(meta.page.sha256);
    },
    TIMEOUT,
  );

  it(
    "produces segments DEEP-EQUAL to the hand-written oracle",
    async () => {
      // THE ASSERTION. Whole array, exact strings, exact floats, exact order.
      // No normalization is applied — none is needed, and none may be added.
      const { segments } = await liveRun();
      expect(segments).toEqual(reference.segments);
    },
    TIMEOUT,
  );

  it(
    "OCR'd byte-identical crops — attenuation yields the oracle's pixels",
    async () => {
      const { seen } = await liveRun();
      const { sha256OfB64 } = await import("../examples/hybrid/engines.ts");
      for (const [id, expected] of Object.entries(meta.crops)) {
        const child = seen.get(`ocr:${id}`);
        expect(child?.cropped).toBeString();
        expect(sha256OfB64(child!.cropped!)).toBe(expected.sha256);
      }
    },
    TIMEOUT,
  );

  it(
    "mounts one specialist per text region and NONE for figures",
    async () => {
      const { creates, regions } = await liveRun();
      expect(creates).toContain("subagent:layout:page1");
      for (const r of regions) {
        const mounted = creates.includes(`subagent:ocr:${r.id}`);
        expect(mounted).toBe(r.tag !== "figure");
      }
      expect(new Set(creates).size).toBe(creates.length); // nothing created twice
    },
    TIMEOUT,
  );

  it(
    "never puts page bytes in a child's config — children pull, never receive",
    async () => {
      const { page, seen } = await liveRun();
      expect(seen.size).toBeGreaterThan(1);
      const pageProbe = page.slice(0, 96);
      for (const [name, child] of seen) {
        const serialized = JSON.stringify(child.config);
        expect(serialized).not.toContain(pageProbe);
        // A whole page raster is ~1MB of base64; a child's durable config is
        // its region id and kind. Size is the blunt version of the same claim.
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
    "the oracle bites: a shifted bbox cannot reproduce the golden text",
    async () => {
      // Sanity that equality is load-bearing. Re-crop one region from a
      // deliberately wrong bbox through the SAME engine and confirm the
      // recognized text differs from the oracle's for that region.
      const { page } = await liveRun();
      const { createHybridEngines } = await import("../examples/hybrid/engines.ts");
      const engines = createHybridEngines();
      const target = reference.segments.find((s) => s.text.length > 40)!;
      const shifted = {
        x0: target.bbox.x0,
        y0: Math.min(0.98, target.bbox.y0 + 0.12),
        x1: target.bbox.x1,
        y1: Math.min(0.99, target.bbox.y1 + 0.12),
      };
      const text = engines.ocr(engines.crop(page, shifted));
      expect(text).not.toBe(target.text);
    },
    TIMEOUT,
  );
});
