/**
 * Phase A1 (RED) — the hand-written flue TARGET FORMAT for the PDF pipeline.
 * See PDF-PIPELINE.md. This file defines the contract; the target module
 * `../src/target/pdf-pipeline.flue.ts` does not exist yet.
 *
 * Oracle: fixtures/pdf/golden-segments.json — extraction of 4 column-scoped
 * regions from the ParseBench sample. May not be weakened.
 */

// Plain-bun assert runner ON PURPOSE (bun main thread). The extraction
// primitive is incompatible with BOTH test harnesses' worker plumbing:
//   - `bun test`: LoopbackPort structuredClone DataCloneError, then fake-worker
//     requestImportModule module-eval failure (unpdf/dist/pdfjs.mjs).
//   - vitest/node (threads AND forks pools): real worker postMessage
//     "Unable to deserialize cloned data".
// Plain `bun <file>` main-thread execution works (same path as the fixture
// generator), and workerd — the deploy target — has its own first-class run
// in compat/pdf-target. Assertions are UNCHANGED from the original spec.
import { strict as assert } from "node:assert";
const cases: [string, () => void | Promise<void>][] = [];
const describe = (_n: string, f: () => void) => f();
const it = (n: string, f: () => void | Promise<void>) => {
  cases.push([n, f]);
};
const expect = (actual: unknown) => ({
  toBe: (e: unknown) => assert.strictEqual(actual, e),
  toBeTruthy: () => assert.ok(actual),
  toEqual: (e: unknown) => assert.deepStrictEqual(actual, e),
  not: { toBe: (e: unknown) => assert.notStrictEqual(actual, e) },
});
import { readFileSync } from "node:fs";
import layoutAnalyst, { bboxExtractorProfile, pipeline } from "../src/target/pdf-pipeline.flue.ts";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";

const golden = JSON.parse(
  readFileSync(new URL("../../../fixtures/pdf/golden-segments.json", import.meta.url), "utf8")
) as { id: string; bbox: unknown; text: string }[];

const fakeHarness = {
  session: async () => ({
    task: async () => {
      throw new Error("the deterministic pipeline must not delegate to a model");
    },
  }),
};

describe("hand-written flue target: pdf → layout → per-bbox text layer", () => {
  it("modules pass flue's real validators", () => {
    expect(layoutAnalyst).toBeTruthy();
    expect((layoutAnalyst as { __flueAgentDefinition?: unknown }).__flueAgentDefinition).toBe(true);
    expect(bboxExtractorProfile.name).toBe("bbox-extractor");
    expect((pipeline as { __flueWorkflowDefinition?: unknown }).__flueWorkflowDefinition).toBe(true);
  });

  it("the workflow reproduces the golden segments from the sample PDF", async () => {
    const result = (await (
      pipeline as { action: { run: (ctx: unknown) => Promise<unknown> } }
    ).action.run({
      harness: fakeHarness,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      input: { pdfB64: SAMPLE_PDF_B64 },
    })) as { segments: { id: string; text: string }[] };

    expect(result.segments.map((s) => s.id)).toEqual(golden.map((g) => g.id));
    expect(result.segments.map((s) => s.text)).toEqual(golden.map((g) => g.text));
  });

  it("the oracle bites: a shifted bbox does not reproduce golden", async () => {
    const { extractTextLayer, b64ToBytes } = await import("../../../examples/pdf/core/extract.ts");
    const bytes = b64ToBytes(SAMPLE_PDF_B64);
    const title = golden.find((g) => g.id === "title")!;
    const shifted = { ...(title.bbox as { x0: number; y0: number; x1: number; y1: number }) };
    shifted.y0 += 0.3;
    shifted.y1 += 0.3;
    expect(await extractTextLayer(bytes, shifted)).not.toBe(title.text);
  });
});

// sequential top-level runner: keeps the event loop owned until every case
// (and pdf.js' fake-worker imports) fully settles.
for (const [name, fn] of cases) {
  await fn();
  console.log("ok -", name);
}
console.log(`pdf-target.check: ${cases.length} pass`);
