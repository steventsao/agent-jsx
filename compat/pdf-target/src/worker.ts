/**
 * Live surface for the hand-written pipeline (deployed as agent-jsx-pdf):
 *   POST /run     body = pdf base64; empty body = the bundled ParseBench sample
 *   GET  /result  { done, segments } — poll until done
 */

import { getAgentByName } from "agents";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
import type { Env } from "./pdf-agents.ts";
export { BboxExtractorDurable, PdfOrchestratorDurable } from "./pdf-agents.ts";

type OrchestratorStub = {
  runPipeline(pdfB64: string): Promise<void>;
  getResult(): Promise<{ done: boolean; segments: { id: string; text: string }[] }>;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const orchestrator = (await getAgentByName(
      env.ORCHESTRATOR as never,
      "pdf-main"
    )) as unknown as OrchestratorStub;

    if (req.method === "POST" && url.pathname === "/run") {
      const body = (await req.text()).trim();
      await orchestrator.runPipeline(body.length > 0 ? body : SAMPLE_PDF_B64);
      return Response.json({ ok: true, sample: body.length === 0 });
    }
    if (url.pathname === "/result") {
      return Response.json(await orchestrator.getResult());
    }
    return new Response(
      "agent-jsx-pdf — hand-written target pipeline.\nPOST /run (b64 body or empty=sample) · GET /result\n"
    );
  },
};
