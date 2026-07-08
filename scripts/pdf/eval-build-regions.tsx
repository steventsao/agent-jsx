/**
 * ParseBench eval — step 1 of 2: build page-appropriate regions from REAL
 * text-item coordinates and compute the LOCAL reference extraction per region
 * (same primitive the worker runs: targets/pdf/core/extract.ts).
 *
 * Mirrors scripts/pdf/build-fixture.tsx (pageTextItems → derive bboxes →
 * extractTextLayer). Writes scripts/pdf/eval-regions.json for the live runner.
 *
 * Run: bun scripts/pdf/eval-build-regions.tsx
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import {
  pageTextItems,
  itemsInBbox,
  joinReadingOrder,
  extractTextLayer,
  bytesToB64,
  type Bbox,
  type PositionedItem,
} from "../../targets/pdf/core/extract.ts";

const DOCS = "/Users/steventsao_personal/dev/ParseBench/data/docs";

interface Pick {
  file: string; // path relative to DOCS
  category: string;
  note: string;
}

const PICKS: Pick[] = [
  { file: "text/text_simple__results.pdf", category: "text", note: "text_content — simple results page" },
  { file: "text/text_simple__edited.pdf", category: "text", note: "text_content — simple edited page" },
  { file: "layout/20240924_000946_P40U_HOWLKAL1IL81NTE2.1_p44.pdf", category: "layout", note: "layout (not the fixture)" },
  { file: "table/222876fb_page22.pdf", category: "table", note: "table page" },
  { file: "chart/US_Professional_Services_Partner_Compensation_Survey_2024_p11.pdf", category: "chart", note: "chart page" },
  { file: "text/text_ocr__p4013.pdf", category: "scanned?", note: "suspected weak/empty text layer (ocr)" },
];

interface Region { id: string; bbox: Bbox }

/** Derive full-page + band/column regions from actual item coordinates. */
function buildRegions(items: PositionedItem[]): Region[] {
  const full: Region = { id: "full", bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  if (items.length < 2) {
    // Empty/scanned fallback: still fan out so we observe "" everywhere.
    return [
      full,
      { id: "top-half", bbox: { x0: 0, y0: 0, x1: 1, y1: 0.5 } },
      { id: "bottom-half", bbox: { x0: 0, y0: 0.5, x1: 1, y1: 1 } },
    ];
  }
  const ymin = Math.min(...items.map((i) => i.y0));
  const ymax = Math.max(...items.map((i) => i.y1));
  const xmin = Math.min(...items.map((i) => i.x0));
  const xmax = Math.max(...items.map((i) => i.x1));
  const ymid = (ymin + ymax) / 2;
  const xmid = (xmin + xmax) / 2;
  return [
    full,
    // vertical bands (split at the content y-midpoint) — exercise banded reading order
    { id: "band-upper", bbox: { x0: 0, y0: 0, x1: 1, y1: ymid } },
    { id: "band-lower", bbox: { x0: 0, y0: ymid, x1: 1, y1: 1 } },
    // columns (split at the content x-midpoint) — exercise column membership
    { id: "col-left", bbox: { x0: 0, y0: 0, x1: xmid, y1: 1 } },
    { id: "col-right", bbox: { x0: xmid, y0: 0, x1: 1, y1: 1 } },
  ];
}

interface OutDoc {
  file: string;
  category: string;
  note: string;
  bytes: number;
  b64Len: number;
  pageItemCount: number;
  regions: Region[];
  local: { id: string; itemCount: number; text: string }[];
  pdfB64: string;
}

const out: OutDoc[] = [];

for (const pick of PICKS) {
  const path = `${DOCS}/${pick.file}`;
  const bytes = new Uint8Array(readFileSync(path));
  const size = statSync(path).size;
  const b64 = bytesToB64(bytes);

  let items: PositionedItem[] = [];
  let err: string | null = null;
  try {
    items = await pageTextItems(bytes.slice());
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }

  const regions = buildRegions(items);
  // No ParseBench page has an empty text layer, so add a guaranteed-empty
  // margin region to the scanned candidate to exercise the "" path + the
  // parent's pending/done derivation over an empty segment.
  if (pick.category === "scanned?") {
    regions.push({ id: "empty-margin", bbox: { x0: 0, y0: 0, x1: 0.02, y1: 0.02 } });
  }
  const local: OutDoc["local"] = [];
  for (const r of regions) {
    const inBox = itemsInBbox(items, r.bbox);
    const text = joinReadingOrder(inBox);
    // sanity: extractTextLayer over raw bytes must equal the item-derived text
    const viaPrimitive = await extractTextLayer(bytes.slice(), r.bbox);
    if (viaPrimitive !== text) {
      console.error(`!! LOCAL MISMATCH ${pick.file} [${r.id}]: primitive !== items path`);
    }
    local.push({ id: r.id, itemCount: inBox.length, text });
  }

  out.push({
    file: pick.file,
    category: pick.category,
    note: pick.note,
    bytes: size,
    b64Len: b64.length,
    pageItemCount: items.length,
    regions,
    local,
    pdfB64: b64,
  });

  console.log(
    `\n=== ${pick.file} [${pick.category}] ${Math.round(size / 1024)}KB b64=${Math.round(b64.length / 1024)}KB items=${items.length}${err ? ` ERR=${err}` : ""}`
  );
  for (const l of local) {
    console.log(`  [${l.id}] items=${l.itemCount} :: ${JSON.stringify(l.text.slice(0, 90))}`);
  }
}

const dst = new URL("./eval-regions.json", import.meta.url);
writeFileSync(dst, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${dst.pathname} (${out.length} docs)`);
