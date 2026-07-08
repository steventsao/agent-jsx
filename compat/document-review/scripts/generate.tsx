/**
 * Compile the document-review example into this package:
 *   src/agents/     authored component/action files, copied with imports rewritten
 *   src/generated/  Cloudflare agent classes + generated HTTP/client/page API
 *
 * The only hand-authored app code is examples/document-review-{agent,actions}.
 * Everything that smells like Worker routing, browser client calls, and DO
 * bindings is generated here.
 */

import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { analyze } from "../../../src/compile/analyze.ts";
import { emitCloudflare, type ChildAgentSpec } from "../../../src/compile/emit-cloudflare.ts";
import { emitCloudflareClientApi } from "../../../src/compile/emit-client-api.ts";
import { copyAgentComponent } from "../../../src/compile/runtime-files.ts";
import { createStore } from "../../../src/state.ts";
import {
  DocumentReviewAgent,
  documentReviewAgent,
  ExtractionAttempt,
  initialDocumentReviewState,
  synthesizeCandidate,
  type DocumentReviewState,
} from "../../../examples/document-review-agent.tsx";

const here = (p: string) => new URL(`../${p}`, import.meta.url);
mkdirSync(here("src/agents"), { recursive: true });
mkdirSync(here("src/generated"), { recursive: true });
mkdirSync(here("src/domain"), { recursive: true });

cpSync(new URL("../../../targets/pdf/core/extract.ts", import.meta.url), here("src/domain/extract.ts"));

copyAgentComponent(
  new URL("../../../examples/document-review-agent.tsx", import.meta.url),
  here("src/agents/document-review-agent.tsx").pathname,
  "../generated/runtime",
  {
    "../targets/pdf/core/extract.ts": "../domain/extract.ts",
  }
);
cpSync(
  new URL("../../../examples/document-review-actions.ts", import.meta.url),
  here("src/agents/document-review-actions.ts")
);

const textLayer = [
  "Unlocking Multimodal Document Intelligence: From Current Triumphs to Future Frontiers of Visual Document Retrieval",
  "Abstract With the rapid proliferation of multimodal information, Visual Document Retrieval has emerged as a critical frontier.",
].join(" ");
const firstCandidate = synthesizeCandidate({
  attempt: 1,
  model: "google/gemini-3-flash",
  label: "Gemini Flash 3",
  textLayer,
});
const sampleSource = {
  channel: "document" as const,
  name: "analysis.pdf",
  mediaType: "application/pdf",
  pdfB64: "analysis-only",
};
const extracting: DocumentReviewState = {
  ...initialDocumentReviewState,
  source: sampleSource,
};
const awaitingReview: DocumentReviewState = {
  ...initialDocumentReviewState,
  source: sampleSource,
  textLayer,
  candidates: [firstCandidate],
};
const secondRequested: DocumentReviewState = {
  ...awaitingReview,
  requestedAttempts: 2,
};
const samples = [initialDocumentReviewState, extracting, { ...extracting, textLayer }, awaitingReview, secondRequested];

const children: ChildAgentSpec[] = [
  {
    spec: ExtractionAttempt.spec,
    exportName: "ExtractionAttempt",
    importPath: "../agents/document-review-agent.tsx",
  },
];

const cf = emitCloudflare(
  {
    spec: documentReviewAgent.spec,
    componentName: "documentReviewAgent",
    componentImport: "../agents/document-review-agent.tsx",
    requestHandlerExport: "handleDocumentReviewAgentRequest",
    requestHandlerImport: "./document-review.api.ts",
  },
  children,
  analyze((i) => <DocumentReviewAgent store={createStore(samples[i]!)} />, samples.length),
  { runtimeImport: "./runtime", emitRuntimeTo: here("src/generated/runtime").pathname }
);

const api = emitCloudflareClientApi({
  agentName: "document-review",
  bindingName: "DOCUMENT_REVIEW",
  stateTypeName: "DocumentReviewState",
  stateImport: "../agents/document-review-agent.tsx",
  actionsImport: "../agents/document-review-actions.ts",
  snapshotExport: "documentReviewSnapshot",
  reducerExport: "runDocumentReviewAction",
  actionTypeName: "DocumentReviewAction",
  clientName: "DocumentReviewGeneratedClient",
  promptBudget: 220,
  title: "Document Review",
  actions: [
    {
      type: "receiveDocument",
      path: "/api/channels/document",
      methodName: "sendDocument",
      params: "input: { name?: string; mediaType?: string; pdfB64: string }",
      body: `{ channel: "document", document: input }`,
      replaceState: true,
    },
    { type: "tryHarder", path: "/api/try-harder", methodName: "tryHarder" },
    {
      type: "ok",
      path: "/api/ok",
      methodName: "ok",
      params: "candidateId?: string",
      body: "{ candidateId }",
    },
    { type: "reset", path: "/api/reset", methodName: "reset", replaceState: true },
  ],
});

writeFileSync(here("src/generated/document-review.cloudflare.ts"), cf.agents);
writeFileSync(here("src/generated/document-review.wrangler.jsonc"), cf.wrangler);
writeFileSync(here("src/generated/document-review.api.ts"), api.api);
console.log("generated: src/generated/document-review.{cloudflare,api}.ts + runtime/");
