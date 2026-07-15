/**
 * Phase A2 — the HAND-WRITTEN cloudflare/agents target for the PDF pipeline.
 * This is the reference the compiled React description must reproduce.
 *
 * Shape (PDF-PIPELINE.md):
 *   PdfOrchestratorDurable.runPipeline(pdfB64)
 *     → pdf into the parent's own DO storage (never state, never child props)
 *     → layout step (fixture regions — deterministic seam; VLM later)
 *     → one BboxExtractorDurable per region, told ONLY {regionId, bbox,
 *       parentName}
 *   BboxExtractorDurable.extract(...)
 *     → PULLS bytes via parent.getPdf() (the capability pattern, v0.6's
 *       method prop by hand) → extractTextLayer IN THIS DO → reports
 *       parent.onSegment(regionId, text)
 *
 * Hard-won rules encoded (COMPAT-REPORT):
 *   #1  always reach agents via getAgentByName — partyserver's `.name` getter
 *       throws under raw-id access and the agents pkg reads it on every
 *       setState. Children therefore get the parent's NAME, not its id.
 *   #3  merge-style setState only (full-replace wipes sibling segments).
 */

import { Agent, getAgentByName } from "agents";
import { REGIONS } from "../../../fixtures/pdf/regions.ts";
import { b64ToBytes, extractTextLayer, type Bbox } from "../../../examples/pdf/core/extract.ts";

export interface Env {
  ORCHESTRATOR: DurableObjectNamespace;
  BBOX_EXTRACTOR: DurableObjectNamespace;
}

interface OrchestratorState extends Record<string, unknown> {
  segments: Record<string, string>;
  started: boolean;
}

type ExtractorStub = {
  extract(input: { regionId: string; bbox: Bbox; parentName: string }): Promise<void>;
};

type OrchestratorStub = {
  getPdf(): Promise<string>;
  onSegment(regionId: string, text: string): Promise<void>;
};

export class PdfOrchestratorDurable extends Agent<Env, OrchestratorState> {
  initialState: OrchestratorState = { segments: {}, started: false };

  /** The parent's name — set by getAgentByName routing; needed so children
   *  can address callbacks. Recorded on first use. */
  #nameForChildren(): string {
    return this.name; // safe: this DO is only ever reached via getAgentByName
  }

  async runPipeline(pdfB64: string): Promise<void> {
    await this.ctx.storage.put("pdf", pdfB64);
    this.setState({ ...this.state, started: true, segments: {} });
    // Layout step (fixture-driven, deterministic). For each bbox: spawn the
    // child with the bbox and a way back — never the bytes.
    for (const region of REGIONS) {
      const child = (await getAgentByName(
        this.env.BBOX_EXTRACTOR as never,
        `extract:${region.id}`
      )) as unknown as ExtractorStub;
      await child.extract({
        regionId: region.id,
        bbox: region.bbox,
        parentName: this.#nameForChildren(),
      });
    }
  }

  /** The capability children pull from — pdf bytes on demand. */
  async getPdf(): Promise<string> {
    const pdf = (await this.ctx.storage.get("pdf")) as string | undefined;
    if (!pdf) throw new Error("no pdf loaded — call runPipeline first");
    return pdf;
  }

  /** Child → parent result fold (merge semantics; see COMPAT-REPORT #3). */
  async onSegment(regionId: string, text: string): Promise<void> {
    this.setState({
      ...this.state,
      segments: { ...this.state.segments, [regionId]: text },
    });
  }

  async getResult(): Promise<{ done: boolean; segments: { id: string; text: string }[] }> {
    const segments = REGIONS.filter((r) => this.state.segments[r.id] !== undefined).map((r) => ({
      id: r.id,
      text: this.state.segments[r.id]!,
    }));
    return { done: segments.length === REGIONS.length, segments };
  }
}

interface ExtractorState extends Record<string, unknown> {
  extracted: string | null;
}

export class BboxExtractorDurable extends Agent<Env, ExtractorState> {
  initialState: ExtractorState = { extracted: null };

  async extract(input: { regionId: string; bbox: Bbox; parentName: string }): Promise<void> {
    const parent = (await getAgentByName(
      this.env.ORCHESTRATOR as never,
      input.parentName
    )) as unknown as OrchestratorStub;
    const pdfB64 = await parent.getPdf(); // pull, don't receive
    const text = await extractTextLayer(b64ToBytes(pdfB64), input.bbox);
    this.setState({ ...this.state, extracted: input.regionId });
    await parent.onSegment(input.regionId, text);
  }
}
