/**
 * Compile the React description of the pdf pipeline into this package.
 * Inputs: examples/pdf/{pdf-pipeline,bbox-extractor}.tsx + the shared spec
 * primitive targets/pdf/core/extract.ts (copied to src/domain/, imports
 * rewritten). The emitted classes must reproduce the hand-written target's
 * golden — that equality is this package's spec.
 */

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { analyze } from "../../../src/compile/analyze.ts";
import { emitCloudflare, type ChildAgentSpec } from "../../../src/compile/emit-cloudflare.ts";
import { copyAgentComponent } from "../../../src/compile/runtime-files.ts";
import { createStore } from "../../../src/state.ts";
import { REGIONS } from "../../../fixtures/pdf/regions.ts";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
import { BboxExtractor } from "../../../examples/pdf/bbox-extractor.tsx";
import {
  initialPdfPipelineState,
  PdfPipeline,
  type PdfPipelineState,
} from "../../../examples/pdf/pdf-pipeline.tsx";

const here = (p: string) => new URL(`../${p}`, import.meta.url);
mkdirSync(here("src/agents"), { recursive: true });
mkdirSync(here("src/generated"), { recursive: true });
mkdirSync(here("src/domain"), { recursive: true });

// the domain primitive travels with the package (unpdf resolves locally)
cpSync(new URL("../../../targets/pdf/core/extract.ts", import.meta.url), here("src/domain/extract.ts"));

const EXTRACT_REWRITE = { "../../targets/pdf/core/extract.ts": "../domain/extract.ts" };
copyAgentComponent(
  new URL("../../../examples/pdf/pdf-pipeline.tsx", import.meta.url),
  here("src/agents/pdf-pipeline.tsx").pathname,
  "../generated/runtime",
  { ...EXTRACT_REWRITE, "./bbox-extractor.tsx": "./bbox-extractor.tsx" }
);
copyAgentComponent(
  new URL("../../../examples/pdf/bbox-extractor.tsx", import.meta.url),
  here("src/agents/bbox-extractor.tsx").pathname,
  "../generated/runtime",
  EXTRACT_REWRITE
);

const loaded: PdfPipelineState = {
  pdfB64: SAMPLE_PDF_B64,
  regions: REGIONS,
  segments: {},
  runId: "sample",
};
const children: ChildAgentSpec[] = [
  { spec: BboxExtractor.spec, exportName: "BboxExtractor", importPath: "../agents/bbox-extractor.tsx" },
];
const samples = [initialPdfPipelineState, loaded];
const PdfPipelineImpl = PdfPipeline.spec.impl;
const out = emitCloudflare(
  { spec: PdfPipeline.spec, componentName: "PdfPipeline", componentImport: "../agents/pdf-pipeline.tsx" },
  children,
  analyze((i) => <PdfPipelineImpl store={createStore(samples[i]!)} />, samples.length),
  { runtimeImport: "./runtime", emitRuntimeTo: here("src/generated/runtime").pathname }
);

writeFileSync(here("src/generated/pdf-pipeline.cloudflare.ts"), out.agents);
writeFileSync(here("src/generated/pdf-pipeline.wrangler.jsonc"), out.wrangler);
console.log("compiled: src/generated/pdf-pipeline.cloudflare.ts + runtime/ + domain/");
