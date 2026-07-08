/**
 * ParseBench eval — step 2 of 2: POST each pdf+regions to the LIVE compiled
 * worker, poll /result until done, and compare live text vs the local
 * reference (scripts/pdf/eval-regions.json) PER REGION. Same primitive both
 * sides → they must be byte-equal; divergence is flagged loudly.
 *
 * /result reflects the LATEST run only (single parent "main"), so docs run
 * SEQUENTIALLY: poll until the returned segment ids match this doc's regions
 * AND done, or ~35s timeout.
 *
 * Run: bun scripts/pdf/eval-run-live.ts
 */

import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://agent-jsx-pdf-compiled.steventsao.workers.dev";
const POLL_MS = 500;
const TIMEOUT_MS = 35_000;

interface Region { id: string; bbox: { x0: number; y0: number; x1: number; y1: number } }
interface InDoc {
  file: string; category: string; note: string; bytes: number; b64Len: number;
  pageItemCount: number; regions: Region[];
  local: { id: string; itemCount: number; text: string }[];
  pdfB64: string;
}

const docs: InDoc[] = JSON.parse(
  readFileSync(new URL("./eval-regions.json", import.meta.url), "utf8")
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ResultBody { done: boolean; segments: { id: string; text: string }[] }

async function postRun(doc: InDoc): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pdfB64: doc.pdfB64, regions: doc.regions }),
  });
  return { status: res.status, body: await res.text() };
}

async function getResult(): Promise<ResultBody> {
  const res = await fetch(`${BASE}/result`);
  return (await res.json()) as ResultBody;
}

interface RegionCmp { id: string; localItemCount: number; live?: string; local: string; equal: boolean; liveMissing: boolean }
interface OutDoc {
  file: string; category: string; note: string; bytes: number; b64Len: number;
  pageItemCount: number; nRegions: number;
  runStatus: number; runOk: boolean; runBody: string;
  done: boolean; latencyMs: number; polls: number;
  idsMatch: boolean; allEqual: boolean;
  regions: RegionCmp[];
}

const results: OutDoc[] = [];

for (const doc of docs) {
  const myIds = doc.regions.map((r) => r.id).sort();
  process.stdout.write(`\n=== ${doc.file} [${doc.category}] ${doc.regions.length} regions, b64=${Math.round(doc.b64Len / 1024)}KB\n`);

  const t0 = Date.now();
  const run = await postRun(doc);
  let runOk = false;
  try { runOk = (JSON.parse(run.body) as { ok?: boolean }).ok === true; } catch { /* non-JSON error body */ }
  process.stdout.write(`  POST /run -> ${run.status} ${run.body.slice(0, 120)}\n`);

  let last: ResultBody = { done: false, segments: [] };
  let done = false;
  let polls = 0;
  let idsMatch = false;
  let latencyMs = -1;
  if (runOk) {
    while (Date.now() - t0 < TIMEOUT_MS) {
      await sleep(POLL_MS);
      polls++;
      try { last = await getResult(); } catch (e) { process.stdout.write(`  poll err ${String(e).slice(0,60)}\n`); continue; }
      const liveIds = last.segments.map((s) => s.id).sort();
      idsMatch = liveIds.length === myIds.length && liveIds.every((v, i) => v === myIds[i]);
      if (last.done && idsMatch) { done = true; latencyMs = Date.now() - t0; break; }
    }
    if (!done) latencyMs = Date.now() - t0;
  }

  const liveById = new Map(last.segments.map((s) => [s.id, s.text]));
  const regionCmp: RegionCmp[] = doc.regions.map((r) => {
    const local = doc.local.find((l) => l.id === r.id)!;
    const live = liveById.get(r.id);
    const liveMissing = live === undefined;
    const equal = !liveMissing && live === local.text;
    return { id: r.id, localItemCount: local.itemCount, live, local: local.text, equal, liveMissing };
  });
  const allEqual = regionCmp.every((c) => c.equal);

  for (const c of regionCmp) {
    if (c.equal) {
      process.stdout.write(`  ✓ [${c.id}] live===local (${c.local.length} chars)\n`);
    } else if (c.liveMissing) {
      process.stdout.write(`  ✗ [${c.id}] LIVE MISSING (local ${c.local.length} chars: ${JSON.stringify(c.local.slice(0, 60))})\n`);
    } else {
      process.stdout.write(`  ✗ [${c.id}] DIVERGENCE\n      live : ${JSON.stringify((c.live ?? "").slice(0, 100))}\n      local: ${JSON.stringify(c.local.slice(0, 100))}\n`);
    }
  }
  process.stdout.write(`  done=${done} idsMatch=${idsMatch} allEqual=${allEqual} latency=${latencyMs}ms polls=${polls}\n`);

  results.push({
    file: doc.file, category: doc.category, note: doc.note, bytes: doc.bytes, b64Len: doc.b64Len,
    pageItemCount: doc.pageItemCount, nRegions: doc.regions.length,
    runStatus: run.status, runOk, runBody: run.body,
    done, latencyMs, polls, idsMatch, allEqual, regions: regionCmp,
  });
}

writeFileSync(new URL("./eval-results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");

process.stdout.write(`\n\n===== SUMMARY =====\n`);
for (const r of results) {
  const snippet = (r.regions.find((c) => c.id === "full")?.live ?? r.regions[0]?.live ?? "").slice(0, 50).replace(/\s+/g, " ");
  process.stdout.write(
    `${r.allEqual && r.done ? "PASS" : "FAIL"}  ${r.file}  [${r.category}]  ${Math.round(r.bytes / 1024)}KB  regions=${r.nRegions}  done=${r.done}  eq=${r.allEqual}  ${r.latencyMs}ms  :: ${JSON.stringify(snippet)}\n`
  );
}
process.stdout.write(`wrote scripts/pdf/eval-results.json\n`);
