/**
 * Freeze the ParseBench sample into fixtures/pdf/:
 *   sample-pdf.ts        — the page as a base64 module (bundles anywhere)
 *   regions.ts           — the layout fixture: what "the layoutparser said"
 *   golden-segments.json — per-region text-layer extraction (the oracle)
 *
 * Layout provenance: regions were chosen on ParseBench's layout-category
 * sample docs/layout/2602.19961v1_p1.pdf (arXiv 2602.19961 p1) from real
 * text-item coordinates; the LAYOUT step is fixture-driven in tests/deploys
 * so the pipeline is deterministic — swap in a live VLM layoutparser later
 * without touching extraction.
 *
 * Regenerate: bun run fixtures:pdf   (goldens must only change when the
 * extraction SPEC in targets/pdf/core/extract.ts changes — review the diff.)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { b64ToBytes, bytesToB64, extractTextLayer, type Bbox } from "../../targets/pdf/core/extract.ts";

const SOURCE = "/Users/steventsao_personal/dev/ParseBench/data/docs/layout/2602.19961v1_p1.pdf";

export interface Region {
  id: string;
  bbox: Bbox;
}

// Normalized top-left [see extract.ts]. Chosen from the page's band structure.
// The page is two-column below the title block, so body regions are
// column-scoped — which is precisely what a layoutparser produces.
export const REGIONS: Region[] = [
  { id: "title", bbox: { x0: 0.08, y0: 0.075, x1: 0.92, y1: 0.135 } },
  { id: "authors", bbox: { x0: 0.08, y0: 0.135, x1: 0.92, y1: 0.158 } },
  { id: "abstract-left", bbox: { x0: 0.08, y0: 0.245, x1: 0.49, y1: 0.375 } },
  { id: "intro-left", bbox: { x0: 0.06, y0: 0.51, x1: 0.49, y1: 0.6 } },
];

if (import.meta.main) {
  const bytes = new Uint8Array(readFileSync(SOURCE));
  const b64 = bytesToB64(bytes);
  const dir = new URL("../../fixtures/pdf/", import.meta.url);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    new URL("sample-pdf.ts", dir),
    `// GENERATED from ParseBench data/docs/layout/2602.19961v1_p1.pdf — do not edit.\n` +
      `export const SAMPLE_PDF_NAME = "ParseBench docs/layout/2602.19961v1_p1.pdf (arXiv 2602.19961 p1)";\n` +
      `export const SAMPLE_PDF_B64 =\n  "${b64}";\n`
  );

  writeFileSync(
    new URL("regions.ts", dir),
    `// GENERATED layout fixture (what the layoutparser said) — do not edit.\n` +
      `import type { Bbox } from "../../targets/pdf/core/extract.ts";\n\n` +
      `export interface Region { id: string; bbox: Bbox }\n\n` +
      `export const REGIONS: Region[] = ${JSON.stringify(REGIONS, null, 2)};\n`
  );

  const golden: { id: string; bbox: Bbox; text: string }[] = [];
  for (const r of REGIONS) {
    const text = await extractTextLayer(b64ToBytes(b64), r.bbox);
    golden.push({ id: r.id, bbox: r.bbox, text });
    console.log(`\n[${r.id}]`, JSON.stringify(text.slice(0, 160)));
  }
  writeFileSync(new URL("golden-segments.json", dir), JSON.stringify(golden, null, 2) + "\n");
  console.log(`\nwrote fixtures/pdf/ (pdf ${Math.round(bytes.length / 1024)}KB, ${REGIONS.length} regions)`);
}
