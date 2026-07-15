/**
 * Phase A2 (RED) — the hand-written cloudflare/agents PDF pipeline in REAL
 * workerd. See ../../PDF-PIPELINE.md. `../src/pdf-agents.ts` and
 * `../src/worker.ts` do not exist yet — this spec is their contract.
 *
 * May not be weakened:
 *   1. runPipeline on the ParseBench sample reproduces the golden segments
 *      (all 4, ordered by the fixture's region order).
 *   2. The child DOs never receive the pdf bytes as input — they PULL via
 *      the parent's getPdf() (the hand-written analog of a method prop).
 *   3. Extraction executes IN THE CHILD DO (child records its region id
 *      after extracting).
 *   4. runPipeline is idempotent: running twice yields the same result and
 *      the same number of children.
 */

import { env, runInDurableObject as runInDurableObjectRaw } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
import golden from "../../../fixtures/pdf/golden-segments.json";

type Orchestrator = {
  state: Record<string, any>;
  runPipeline(pdfB64: string): Promise<void>;
  getResult(): Promise<{ done: boolean; segments: { id: string; text: string }[] }>;
  getPdf(): Promise<string>;
};

type Extractor = {
  state: Record<string, any>;
};

declare module "cloudflare:test" {
  interface ProvidedEnv {
    ORCHESTRATOR: DurableObjectNamespace;
    BBOX_EXTRACTOR: DurableObjectNamespace;
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      ORCHESTRATOR: DurableObjectNamespace;
      BBOX_EXTRACTOR: DurableObjectNamespace;
    }
  }
}

const runInDurableObject = <TAgent, TResult>(
  stub: DurableObjectStub,
  callback: (agent: TAgent) => TResult | Promise<TResult>,
) =>
  runInDurableObjectRaw(stub, (instance) =>
    callback(instance as unknown as TAgent),
  );

const orchestrator = async () =>
  (await getAgentByName(env.ORCHESTRATOR as never, "pdf-main")) as never as DurableObjectStub;

async function runAndAwaitResult(): Promise<{ done: boolean; segments: { id: string; text: string }[] }> {
  const stub = await orchestrator();
  await runInDurableObject(stub, async (agent: Orchestrator) => {
    await agent.runPipeline(SAMPLE_PDF_B64);
  });
  // extraction is child-DO work; poll the parent until all segments folded
  for (let i = 0; i < 40; i++) {
    const result = await runInDurableObject(await orchestrator(), (agent: Orchestrator) =>
      agent.getResult()
    );
    if (result.done) return result;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("pipeline did not complete");
}

describe("hand-written cloudflare/agents pdf pipeline (real workerd)", () => {
  it("reproduces the golden segments end-to-end", async () => {
    const result = await runAndAwaitResult();
    expect(result.segments.map((s) => s.id)).toEqual(golden.map((g) => g.id));
    expect(result.segments.map((s) => s.text)).toEqual(golden.map((g) => g.text));
  });

  it("children pulled the pdf (no bytes pushed as input) and extracted in-DO", async () => {
    for (const g of golden) {
      const child = (await getAgentByName(
        env.BBOX_EXTRACTOR as never,
        `extract:${g.id}`
      )) as never as DurableObjectStub;
      await runInDurableObject(child, (c: Extractor) => {
        const state = JSON.stringify(c.state);
        expect(state).not.toContain(SAMPLE_PDF_B64.slice(0, 64)); // bytes never pushed/persisted
        expect(c.state.extracted).toBe(g.id); // work happened in THIS DO
      });
    }
  });

  it("is idempotent across repeated runs", async () => {
    const first = await runAndAwaitResult();
    const second = await runAndAwaitResult();
    expect(second.segments).toEqual(first.segments);
  });
});
