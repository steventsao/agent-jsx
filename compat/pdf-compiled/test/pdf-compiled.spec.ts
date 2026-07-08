/**
 * Phase B finish line (workerd half) — the COMPILED React description must
 * reproduce the Phase A golden on the same destination. Copy into
 * compat/pdf-compiled/test/ on placement.
 *
 * May not be weakened:
 *   1. POST-equivalent state load (applyState with pdf + fixture regions) →
 *      segments deep-equal fixtures/pdf/golden-segments.json.
 *   2. Child __props NEVER contain the pdf bytes (getPdf method prop pulls).
 *   3. Task idempotency: reconcile storms don't re-extract (__tasksDone guard).
 */

import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
import { REGIONS } from "../../../fixtures/pdf/regions.ts";
import golden from "../../../fixtures/pdf/golden-segments.json";
import worker from "../src/worker.ts";

type Pipeline = {
  state: Record<string, any>;
  applyState(u: Record<string, unknown>): Promise<void>;
  readState(): Promise<Record<string, any>>;
  reconcile(): Promise<void>;
};

type MountedChild = { name: string; kind: string };

declare module "cloudflare:test" {
  interface ProvidedEnv {
    PDF_PIPELINE: DurableObjectNamespace;
    BBOX_EXTRACTOR: DurableObjectNamespace;
  }
}

const parent = async () =>
  (await getAgentByName(env.PDF_PIPELINE as never, "main")) as never as DurableObjectStub;

async function driveChildren(state: Record<string, any>): Promise<void> {
  for (const child of (state.__children ?? []) as MountedChild[]) {
    const res = await worker.fetch(
      new Request(`https://pdf-compiled.test/agents/${child.kind}/${child.name}/api/drive`, { method: "POST" }),
      env
    );
    expect(res.status).toBeLessThan(500);
  }
}

async function loadAndAwait(): Promise<Record<string, string>> {
  await runInDurableObject(await parent(), async (p: Pipeline) => {
    await p.applyState({ pdfB64: SAMPLE_PDF_B64, regions: REGIONS, segments: {}, runId: "t1" });
  });
  for (let i = 0; i < 60; i++) {
    const state = await runInDurableObject(await parent(), (p: Pipeline) => p.readState());
    if (REGIONS.every((r) => state.segments[r.id])) return state.segments;
    await driveChildren(state);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("compiled pipeline did not complete");
}

describe("COMPILED pdf pipeline reproduces the hand-written target's golden", () => {
  it("segments equal the oracle", async () => {
    const segments = await loadAndAwait();
    for (const g of golden as { id: string; text: string }[]) {
      expect(segments[g.id]).toBe(g.text);
    }
  });

  it("children pulled the pdf via the method prop — no bytes in child props", async () => {
    for (const r of REGIONS) {
      const child = (await getAgentByName(
        env.BBOX_EXTRACTOR as never,
        `extract:t1:${r.id}`
      )) as never as DurableObjectStub;
      await runInDurableObject(child, (c: { state: Record<string, any> }) => {
        expect(JSON.stringify(c.state.__props ?? {})).not.toContain(SAMPLE_PDF_B64.slice(0, 64));
      });
    }
  });

  it("re-reconcile does not re-run tasks (idempotency guard)", async () => {
    const before = await runInDurableObject(await parent(), (p: Pipeline) => p.readState());
    await runInDurableObject(await parent(), async (p: Pipeline) => {
      await p.reconcile();
      await p.reconcile();
    });
    const after = await runInDurableObject(await parent(), (p: Pipeline) => p.readState());
    expect(after.segments).toEqual(before.segments);
  });
});
