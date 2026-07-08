/**
 * Regenerate examples/fixtures/graphicbench-witnesses.json from okra's REAL
 * committed graphicbench chart-page run. One-shot dev tool (NOT part of
 * `bun run all` — the demo ships the committed fixture so it runs without the
 * okra checkout present).
 *
 *   bun scripts/gen-verify-fixture.ts
 *   OKRA_SUMMARY=/path/to/summary.json bun scripts/gen-verify-fixture.ts
 *
 * Source of truth (committed in the okra monorepo):
 *   okra/data/eval-pdfs/graphicbench/assets/parse-html-runs/
 *     2026-06-08-parse-html-parsebench-charts/summary.json
 *
 * Each chart page was read by TWO independent witnesses:
 *   - textlayer : deterministic PDF text-layer extraction  (run system "textlayer")
 *   - vlm-html  : a VLM reading the page image             (run system "vlm-html")
 * We take each witness's `metrics.unique_number_coverage` (fraction of the
 * page's ground-truth numbers it recovered) as that witness's per-page reading.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE =
  process.env.OKRA_SUMMARY ??
  "/Users/steventsao_personal/dev/okra/data/eval-pdfs/graphicbench/assets/parse-html-runs/2026-06-08-parse-html-parsebench-charts/summary.json";
const OUT = resolve(HERE, "../examples/fixtures/graphicbench-witnesses.json");

interface Result {
  item_id: string;
  system: string;
  metrics: {
    unique_number_coverage: number;
    unique_token_coverage: number;
    unique_source_numbers: number;
  };
}
interface Summary {
  run_name: string;
  system_summaries: Array<{
    system: string;
    total: number;
    unique_number_coverage_avg: number;
    unique_token_coverage_avg: number;
  }>;
  results: Result[];
}

const run = JSON.parse(readFileSync(SOURCE, "utf8")) as Summary;

const byPage = new Map<string, Partial<Record<"textlayer" | "vlm-html", Result>>>();
for (const r of run.results) {
  const entry = byPage.get(r.item_id) ?? {};
  entry[r.system as "textlayer" | "vlm-html"] = r;
  byPage.set(r.item_id, entry);
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const pages = [...byPage.entries()].map(([item_id, e]) => {
  const t = e.textlayer!;
  const v = e["vlm-html"]!;
  return {
    pageId: item_id.replace(/^charts\//, ""),
    sourceNumbers: t.metrics.unique_source_numbers,
    textNumberCoverage: round(t.metrics.unique_number_coverage),
    vlmNumberCoverage: round(v.metrics.unique_number_coverage),
    textTokenCoverage: round(t.metrics.unique_token_coverage),
    vlmTokenCoverage: round(v.metrics.unique_token_coverage),
  };
});

const out = {
  _provenance: {
    note: "Two independent witnesses per chart page, from a REAL okra graphicbench run. Do not hand-edit — regenerate with scripts/gen-verify-fixture.ts against the okra checkout.",
    sourceRun: run.run_name,
    sourceFile:
      "okra/data/eval-pdfs/graphicbench/assets/parse-html-runs/2026-06-08-parse-html-parsebench-charts/summary.json",
    dataset: "graphicbench / parsebench-chart-pages",
    witnesses: {
      textlayer: 'deterministic PDF text-layer read (system "textlayer", cost_usd 0)',
      "vlm-html": 'VLM page-image read (system "vlm-html", gemini-3-flash-preview)',
    },
    metric:
      "unique_number_coverage — fraction of the page's ground-truth numeric tokens each witness recovered (metrics.unique_number_coverage in the run)",
    aggregates: run.system_summaries.map((s) => ({
      system: s.system,
      numberCoverageAvg: s.unique_number_coverage_avg,
      tokenCoverageAvg: s.unique_token_coverage_avg,
      n: s.total,
    })),
  },
  pages,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${pages.length} witness pairs → ${OUT}`);
for (const p of pages) {
  const d = Math.abs(p.textNumberCoverage - p.vlmNumberCoverage);
  console.log(
    `  ${p.pageId.padEnd(30)} text=${p.textNumberCoverage.toFixed(3)}  vlm=${p.vlmNumberCoverage.toFixed(3)}  |Δ|=${d.toFixed(3)}`,
  );
}
