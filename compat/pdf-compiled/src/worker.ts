/**
 * Live surface for the COMPILED pipeline (deployed as agent-jsx-pdf-compiled):
 *   POST /run     empty body = bundled ParseBench sample (or pdf b64 body)
 *   GET  /result  { done, segments } in fixture region order
 * Same contract as the hand-written agent-jsx-pdf worker — the two live
 * /result payloads must be equal (the goal's finish line).
 */

import { getAgentByName, routeAgentRequest } from "agents";
import { REGIONS } from "../../../fixtures/pdf/regions.ts";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
export { PdfPipelineDurable, BboxExtractorDurable } from "./generated/pdf-pipeline.cloudflare.ts";

interface Env {
  PDF_PIPELINE: DurableObjectNamespace;
  BBOX_EXTRACTOR: DurableObjectNamespace;
}

type PipelineStub = {
  applyState(update: Record<string, unknown>): Promise<void>;
  readState(): Promise<{ regions: { id: string }[]; segments: Record<string, string> }>;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const pipeline = (await getAgentByName(env.PDF_PIPELINE as never, "main")) as unknown as PipelineStub;

    if (req.method === "POST" && url.pathname === "/run") {
      const body = (await req.text()).trim();
      // Accept JSON { pdfB64, regions? } or a raw base64 body; empty = sample.
      let pdfB64 = SAMPLE_PDF_B64;
      let regions: unknown = REGIONS;
      if (body.startsWith("{")) {
        const parsed = JSON.parse(body) as { pdfB64?: string; regions?: unknown };
        if (parsed.pdfB64) pdfB64 = parsed.pdfB64;
        if (parsed.regions) regions = parsed.regions;
      } else if (body.length > 0) {
        pdfB64 = body;
      }
      const runId = crypto.randomUUID().slice(0, 8);
      await pipeline.applyState({ pdfB64, regions, segments: {}, runId });
      return Response.json({ ok: true, runId, sample: pdfB64 === SAMPLE_PDF_B64 });
    }
    if (url.pathname === "/result") {
      const state = await pipeline.readState();
      const segments = state.regions
        .filter((r) => state.segments[r.id] !== undefined)
        .map((r) => ({ id: r.id, text: state.segments[r.id]! }));
      return Response.json({ done: segments.length === state.regions.length && segments.length > 0, segments });
    }
    const routed = await routeAgentRequest(req, env);
    if (routed) return routed;
    return new Response(
      "agent-jsx-pdf-compiled — the React description, compiled.\nPOST /run · GET /result\n"
    );
  },
};
