/**
 * Phase A1 — the HAND-WRITTEN flue TARGET FORMAT for the PDF pipeline.
 * See ../../../../PDF-PIPELINE.md. This is the reference "pipeline in flue"
 * that Phase B's emitter must later reproduce; it is authored by hand, not
 * generated.
 *
 * Real flue API shape (verified against ~/dev/flue, read-only; cited in
 * COMPAT-REPORT.md #8, #12–#15):
 *   - defineAgentProfile({ name, ... }) validates eagerly and returns the
 *     profile; `name` is profile-only and must match /^[A-Za-z][\w-]*$/
 *     (agent-definition.ts:60-63, :311-318) — "bbox-extractor" qualifies.
 *   - defineAgent(initializer) returns a frozen
 *     { __flueAgentDefinition: true, initialize } (agent-definition.ts:76-87).
 *     The runtime config has NO top-level `name` (COMPAT-REPORT #8).
 *   - defineWorkflow({ agent, input, run }) folds run() into `.action` and
 *     returns a frozen { __flueWorkflowDefinition, agent, action }
 *     (workflow-definition.ts:52-105). The runnable is workflow.action.run.
 *   - run(context) receives an ActionContext = { harness, log, input }
 *     (action.ts:18-23); `input` must be a TOP-LEVEL object schema or
 *     defineAction throws (action.ts:83-85), and @flue/runtime does not
 *     re-export valibot, so we import it directly (COMPAT-REPORT #14).
 *
 * The extraction/delegation split (recorded honestly per PDF-PIPELINE.md):
 * text-layer extraction is DETERMINISTIC CODE (targets/pdf/core/extract.ts),
 * so the workflow IS the fan-out — run() maps the layout regions through
 * extractTextLayer and never calls session.task(). The bbox-extractor
 * profile below exists as the delegation target for a future MODEL-DRIVEN
 * path (it is a declared subagent of the parent), but the deterministic
 * pipeline must not delegate to a model — which is exactly why the compat
 * test's fake harness makes task() throw.
 */

import * as v from "valibot";
import { defineAgent, defineAgentProfile, defineWorkflow } from "@flue/runtime";
import { REGIONS } from "../../../../fixtures/pdf/regions.ts";
import { b64ToBytes, extractTextLayer, type Bbox } from "../../../../targets/pdf/core/extract.ts";

/**
 * The child agent shape: given a page and a bbox, return the text layer within
 * it. This is the delegation target for the model-driven path; the
 * deterministic workflow below calls the same primitive inline instead.
 */
export const bboxExtractorProfile = defineAgentProfile({
  name: "bbox-extractor",
  description:
    "Extracts the text layer within a single layout bbox of a PDF page (normalized top-left coords; center-in-bbox membership; y-band then x reading order).",
  instructions:
    "You are given a PDF page and one normalized bbox { x0, y0, x1, y1 }. Return only the text whose items' centers fall inside the bbox, in reading order, whitespace collapsed. Do not summarize or add commentary.",
});

/**
 * The layout-analyst parent: it decides the page's regions (in the deterministic
 * target these come from the layout fixture — a live VLM layoutparser is a
 * later swap) and fans each bbox out to a bbox-extractor.
 */
const layoutAnalyst = defineAgent(() => ({
  model: "openrouter/google/gemini-3.1-flash-lite-preview",
  instructions:
    "You are a document layout analyst. Segment a PDF page into labeled regions (title, authors, abstract, body columns, ...) and, for each region, delegate text-layer extraction of its bbox to the bbox-extractor subagent.",
  // The child profile is a real declared subagent of this parent — the
  // model-driven delegation target. The deterministic workflow does not use it.
  subagents: [bboxExtractorProfile],
}));

export default layoutAnalyst;

interface Segment {
  id: string;
  bbox: Bbox;
  text: string;
}

/**
 * The deterministic dataflow: layout regions (fixture) → for each bbox
 * extractTextLayer(pdf, bbox) → { segments }. Extraction is code, so run()
 * fans out over the primitive directly and never touches context.harness's
 * model transport.
 */
export const pipeline = defineWorkflow({
  agent: layoutAnalyst,
  input: v.object({ pdfB64: v.string() }),
  run: async (context) => {
    const bytes = b64ToBytes(context.input.pdfB64);
    const segments: Segment[] = [];
    // Layout step: the regions the layoutparser reported (fixture-driven so the
    // pipeline is deterministic). Order is the fixture's region order, which is
    // the golden oracle's order.
    for (const region of REGIONS) {
      const text = await extractTextLayer(bytes, region.bbox);
      segments.push({ id: region.id, bbox: region.bbox, text });
    }
    return { segments };
  },
});
