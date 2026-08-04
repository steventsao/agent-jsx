/**
 * PHASE B, half 1 — real models behind the composition's engine seam.
 *
 * `ReceiptEngines` in examples/receipt is the swap seam the receipt cascade
 * was built to demonstrate: "deterministic fixtures in tests swap for live
 * models without touching composition". This file IS that swap. Same shape,
 * same call signatures — the fixture functions are replaced by two real
 * paper-backed models:
 *
 *   layout : DocLayout-YOLO (juliozhao/DocLayout-YOLO-DocStructBench,
 *            doclayout_yolo_docstructbench_imgsz1024.pt) — arXiv 2410.12628,
 *            the layout stage of MinerU (arXiv 2409.18839).
 *   ocr    : RapidOCR 1.4.4 (PP-OCRv4 det+cls+rec, ONNXRuntime CPU) —
 *            arXiv 2009.09941.
 *   table  : RapidTable 3.0.2 / SLANet-plus (PP-Structure, ONNXRuntime CPU) —
 *            arXiv 2210.05391, SLANet lineage surveyed in arXiv 2507.05595.
 *
 * The table engine is a THIRD capability of exactly the same shape as `ocr`:
 * crop in, structured value out, one short-lived process. Adding it did not
 * change how any existing capability is called.
 *
 * WHY SHELL OUT INSTEAD OF PORTING THE PIXEL MATH TO TS: the experiment asks
 * whether the *composition grammar* reproduces the *hand-written pipeline*.
 * If cropping were reimplemented here, a 1px rounding difference would fail
 * the equality test for a reason that has nothing to do with composition. So
 * `crop` is a capability like any other, and its implementation is the same
 * `engines.py crop` subcommand the Phase A oracle calls. Both paths therefore
 * OCR byte-identical crops — asserted, not assumed, via the crop sha256s in
 * reference-meta.json.
 *
 * Every call is one short-lived `engines.py` process. That is slow (~5s of
 * model load per call) and completely deliberate: a live child agent would
 * make a fresh call to a fresh model host too.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { SAMPLE_PDF_B64 } from "../../fixtures/pdf/sample-pdf.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const HYBRID_DIR = join(HERE, "..", "..", "scripts", "hybrid");
const PYTHON = join(HYBRID_DIR, ".venv", "bin", "python");
const ENGINES_PY = join(HYBRID_DIR, "engines.py");

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
  score: number;
}

/** The engine seam. Structurally the receipt example's `ReceiptEngines`, with
 *  `crop` promoted from a pure module helper to an engine — because with real
 *  rasters, cropping is a model-adjacent pixel operation that must be owned by
 *  exactly one implementation. */
export interface HybridEngines {
  /** page (base64 PNG) -> tagged, ordered, normalized regions. */
  layout: (page: string) => Region[];
  /** (page, bbox) -> crop (base64 PNG). The parent attenuates this per region. */
  crop: (page: string, bbox: Bbox) => string;
  /** crop (base64 PNG) -> recognized text. */
  ocr: (crop: string) => string;
  /** crop (base64 PNG) -> a rectangular grid of cell strings (engines.py D7). */
  table: (crop: string) => string[][];
}

// ---------------------------------------------------------------------------

let scratch: string | null = null;
const workdir = (): string => (scratch ??= mkdtempSync(join(tmpdir(), "hybrid-jsx-")));

let seq = 0;
const tmpPath = (ext: string): string => join(workdir(), `t${seq++}${ext}`);

function py<T>(args: string[]): T {
  const proc = spawnSync(PYTHON, [ENGINES_PY, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(
      `engines.py ${args[0]} failed (exit ${proc.status})\n${proc.stderr ?? ""}`,
    );
  }
  // The HF hub prints an unauthenticated-requests notice; take the last JSON line.
  const line = proc.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error(`engines.py ${args[0]} produced no JSON:\n${proc.stdout}`);
  return JSON.parse(line) as T;
}

const readB64 = (path: string): string => readFileSync(path).toString("base64");
const writeB64 = (b64: string, ext: string): string => {
  const path = tmpPath(ext);
  writeFileSync(path, Buffer.from(b64, "base64"));
  return path;
};

export const sha256OfB64 = (b64: string): string =>
  createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

// ---------------------------------------------------------------------------

export interface RenderedPage {
  page: string;
  sha256: string;
  width: number;
  height: number;
}

/** Render page 1 of a PDF at the pinned DPI, as base64 — the page bytes the
 *  composition holds in state and never hands to a child. */
function renderPdf(pdfPath: string): RenderedPage {
  const out = tmpPath(".png");
  const info = py<{ sha256: string; width: number; height: number }>([
    "render-page",
    pdfPath,
    out,
  ]);
  return { page: readB64(out), sha256: info.sha256, width: info.width, height: info.height };
}

/**
 * The repo's committed ParseBench sample (arXiv 2602.19961v1 p1) — 12 text
 * regions and a figure, NO table.
 *
 * The base64 PDF is pulled through the repo's own fixture module, NOT through
 * scripts/hybrid/sample_pdf.py, so the two paths reach the renderer
 * independently. They must still produce the same page sha256.
 */
export function renderSamplePage(): RenderedPage {
  return renderPdf(writeB64(SAMPLE_PDF_B64, ".pdf"));
}

/** Page 32 of the SAME arXiv paper, which carries a real table (9 text
 *  regions + 1 table, no figure).
 *
 *  Unlike the sample page there is no second decode path here: both phases
 *  open the same committed one-page PDF. The page sha256 is still asserted
 *  against the oracle's, so identical input pixels remain PROVEN rather than
 *  assumed — what is not additionally exercised is the base64-fixture decode. */
export function renderTablePage(): RenderedPage {
  return renderPdf(join(HYBRID_DIR, "fixtures", "table-page.pdf"));
}

export const PUBTABNET_PNG = join(
  HYBRID_DIR,
  "fixtures",
  "pubtabnet-PMC5343394_003_00.png",
);

/**
 * A PubTabNet table with MERGED cells (PMC5343394 Table 3, CC BY 4.0 — see
 * scripts/hybrid/fixtures/LICENSES.md). The fixture engines.py rule D7 exists
 * for: 10 `rowspan=2` merges whose text must be repeated into both rows.
 *
 * Unlike the other two inputs this one is ALREADY a raster, so there is no
 * render step — the committed PNG is the page, byte for byte, in both phases.
 * That is also why nothing here shells out to python: re-encoding the fixture
 * would change the very bytes whose sha256 the oracle pins.
 */
export function loadPubtabnetPage(): RenderedPage {
  const bytes = readFileSync(PUBTABNET_PNG);
  const page = bytes.toString("base64");
  return {
    page,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...pngSize(bytes),
  };
}

/** Width/height straight out of the PNG IHDR — cheaper and more honest than
 *  booting a model process to ask an image its size. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452 /* "IHDR" */) {
    throw new Error(`${PUBTABNET_PNG} is not a PNG with a leading IHDR chunk`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function createHybridEngines(): HybridEngines {
  return {
    layout: (page) => {
      const pagePath = writeB64(page, ".png");
      return py<{ regions: Region[] }>(["layout", pagePath]).regions;
    },
    crop: (page, bbox) => {
      const pagePath = writeB64(page, ".png");
      const out = tmpPath(".png");
      py(["crop", pagePath, out, "--bbox", [bbox.x0, bbox.y0, bbox.x1, bbox.y1].join(",")]);
      return readB64(out);
    },
    ocr: (crop) => py<{ text: string }>(["ocr", writeB64(crop, ".png")]).text,
    // `engines.py table` also returns the model's pre-placement `spans`/`cells`.
    // The composition deliberately does NOT take them: they are D7 evidence for
    // the oracle's meta file, and a specialist that could see them could report
    // a grid its own spans did not justify.
    table: (crop) => py<{ rows: string[][] }>(["table", writeB64(crop, ".png")]).rows,
  };
}

/** Model + runtime provenance, straight from the engines module. */
export const enginesVersion = (): Record<string, unknown> => py(["version"]);
