# PDF pipeline — the target format, TDD'd to a deploy, then compiled from React

**STATUS: COMPLETE (2026-07-07).** Phase A live at agent-jsx-pdf.steventsao.workers.dev; Phase B live at agent-jsx-pdf-compiled.steventsao.workers.dev; live `/result` payloads diff-equal to each other AND to the golden oracle (`COMPILED === HAND-WRITTEN === GOLDEN`). Divergences: COMPAT-REPORT #25–#32.

The goal (verbatim intent): given a PDF, a parent agent does layout parsing; for
each bbox, the PDF + bbox go to a child that extracts the text layer within it —
on a ParseBench sample. Write the TARGET FORMAT by hand first (flue shape + a
cloudflare/agents deploy), TDD until it works on a real deploy, THEN describe the
same pipeline in React and prove the compiler reproduces the working destination.

## Fixed vocabulary (all phases share it)

- Sample: `fixtures/pdf/sample-pdf.ts` — ParseBench `docs/layout/2602.19961v1_p1.pdf` (arXiv 2602.19961 p1), base64 module.
- Layout: `fixtures/pdf/regions.ts` — 4 column-scoped regions (what "the layoutparser said"; fixture-driven so the pipeline is deterministic — a live VLM layoutparser is a later swap that must not touch extraction).
- Extraction spec: `targets/pdf/core/extract.ts` — bbox = normalized TOP-LEFT `{x0,y0,x1,y1}`; item membership = center-in-bbox; reading order = y-band then x; whitespace collapsed; unpdf (serverless pdf.js).
- Oracle: `fixtures/pdf/golden-segments.json` — regenerate ONLY when the extraction spec changes (`bun run fixtures:pdf`), review the diff.

## Phase A — hand-written targets (RED → deploy)

### A1. flue target format (hand-written reference, real @flue/runtime)
`compat/flue/src/target/pdf-pipeline.flue.ts` — HAND-WRITTEN, not generated:
- `bboxExtractorProfile = defineAgentProfile(...)` — the child agent shape (delegation target for the model-driven path).
- default export `defineAgent(...)` — the layout-analyst parent.
- `export const pipeline = defineWorkflow({ agent, input: v.object({ pdfB64: v.string() }), run })` — the deterministic dataflow: layout regions (fixture) → for each bbox `extractTextLayer(pdf, bbox)` → `{ segments: [{id, bbox, text}] }`. Extraction is code, not an LLM task — the workflow IS the fan-out; the subagent profile exists for model-driven delegation, and the contract records that split honestly.

Test (RED): `compat/flue/test/pdf-target.test.ts` — module passes flue's real validators; `pipeline.action.run({harness: fakeTransport, log, input})` returns segments deep-equal to the golden oracle; a wrong bbox does NOT reproduce golden (sanity that the oracle bites).

### A2. cloudflare/agents target (hand-written classes, workerd + LIVE deploy)
`compat/pdf-target/` package. HAND-WRITTEN `src/pdf-agents.ts`:
- `PdfOrchestratorDurable`: `runPipeline(pdfB64)` stores the PDF in its own DO storage (NOT in state — 378KB doesn't belong in the state broadcast), runs the layout step (fixture regions), spawns one `BboxExtractorDurable` per region via `getAgentByName`, passing ONLY `{regionId, bbox}` + a parent ref.
- `BboxExtractorDurable`: pulls the bytes via the parent's `getPdf()` (the hand-written analog of a v0.6 method prop), runs `extractTextLayer` IN THE CHILD DO, reports back via `parent.onSegment(regionId, text)`.
- Parent folds segments into state; `getResult()` returns `{done, segments}`.
- Worker routes: `POST /run` (body = pdf b64; empty body = bundled sample), `GET /result`.

Tests (RED): `compat/pdf-target/test/pdf-target.spec.ts` in REAL workerd — runPipeline on the sample yields segments deep-equal golden (all 4, correct order by region id); the child's inputs never contain the pdf bytes (the pull proves the capability pattern); repeated runPipeline is idempotent (same result, no duplicate children).

DEPLOY (required, pre-authorized): `wrangler deploy` as **agent-jsx-pdf** from `compat/pdf-target/wrangler.jsonc`, then verify live: `POST /run` → poll `GET /result` until done → segments equal golden. Record transcript + divergences in COMPAT-REPORT (continue numbering).

## Phase B — the React description compiles to the working destination

Components in `examples/pdf/`:
- `bbox-extractor.tsx` — `agentComponent` child: props `{ regionId, bbox, getPdf, onSegment }` (`getPdf` is a v0.6 method prop). Declares its work via the NEW one-shot **`<task name run onDone/>`** intrinsic (the "do work on mount" primitive this phase forces into the framework: sim executes it, the CF template executes it exactly once per name, the flue executor runs it inline).
- `pdf-pipeline.tsx` — parent: state `{ pdfLoaded, regions, segments }`; `regions.map(r => <BboxExtractor .../>)` fan-out; prompt shows extraction progress.

Tests (RED): sim/unit semantics for `<task>`; emitter contract (task in the CF template, executed-once guard); workerd: the COMPILED classes reproduce the SAME golden oracle; live: deploy **agent-jsx-pdf-compiled**, `POST /run` → `GET /result` equal to the Phase A worker's live output (cross-worker equality = the goal's finish line).

## Rules (same regime as COMPAT.md)
Fix targets/emitters, never weaken assertions; factual test corrections need source citations; no mocking `agents`/`@flue/runtime`/unpdf; goldens change only with the extraction spec; deploys limited to agent-jsx-pdf and agent-jsx-pdf-compiled; all previously green gates stay green.
