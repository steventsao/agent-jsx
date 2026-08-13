/**
 * The parse PM against REAL workerd + the real `agents` package (0.20.1).
 *
 * May not be weakened:
 *   1. Bearer guard: every /api route 401s without env.DEMO_ACCESS_TOKEN.
 *   2. A straight run drives ingest→…→done and reproduces the golden oracle
 *      (unpdf extraction inside workerd), with an attenuated audit trail:
 *      child inputs are {regionId} only — no pdf bytes, no bbox, no
 *      credential material.
 *   3. Budget exhaustion parks at `paused` with a checkpoint naming exactly
 *      the paid regions; a SIMULATED EVICTION (DurableObjectState#abort — the
 *      instance dies, SQLite survives) rehydrates the same checkpoint; top-up
 *      resumes and the durable ledger proves completed regions were never
 *      re-called; a further resume is a no-op.
 *   4. An eviction MID-DRIVE (a metered call in flight) leaves an interrupted
 *      `parse-drive` fiber row; on the next wake the agents runtime calls
 *      onFiberRecovered, which re-drives from the checkpointed state to done.
 *
 * Every flow is one self-contained `it` block (per-test storage isolation).
 * The provider is ALWAYS the scripted fake (PARSE_PM_FAKE_PROVIDER=1 in
 * wrangler.jsonc); the live OpenRouter path never executes in tests.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
import golden from "../../../fixtures/pdf/golden-segments.json";
import { FAKE_PROVIDER_KEY } from "../src/agents/fake-provider.ts";
import worker, { type StatusPayload } from "../src/worker.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      PARSE_PM_AGENT: DurableObjectNamespace;
      DEMO_ACCESS_TOKEN: string;
      PARSE_PM_FAKE_PROVIDER?: string;
    }
  }
}

const TOKEN = "parse-pm-test-token";
const GOLDEN = golden as Array<{ id: string; text: string }>;
const PDF_MARKER = SAMPLE_PDF_B64.slice(0, 64);
const ALL_REGIONS = ["title", "authors", "abstract-left", "intro-left"];

async function api(
  id: string,
  action: "run" | "status" | "topup" | "resume",
  body?: Record<string, unknown>,
  token: string | null = TOKEN,
): Promise<{ status: number; payload: StatusPayload & { error?: string } }> {
  const method = action === "status" ? "GET" : "POST";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await worker.fetch(
    new Request(`https://parse-pm.test/api/parse/${id}/${action}`, {
      method,
      headers,
      body: method === "POST" && body ? JSON.stringify(body) : undefined,
    }),
    env,
  );
  return { status: response.status, payload: (await response.json()) as never };
}

async function stubFor(id: string): Promise<DurableObjectStub> {
  return (await getAgentByName(env.PARSE_PM_AGENT as never, id)) as never as DurableObjectStub;
}

/** Kill the live instance while its SQLite storage survives. `abort()` breaks
 *  the actor; the rejected runInDurableObject call IS the eviction. */
async function evict(id: string): Promise<void> {
  const stub = await stubFor(id);
  await runInDurableObject(stub, (_instance: unknown, state: DurableObjectState) => {
    state.abort("simulated eviction");
  }).catch(() => {});
}

async function until<T>(
  probe: () => Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  timeoutMs = 45000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await probe();
    if (ready(value)) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${label} not reached in ${timeoutMs}ms: ${JSON.stringify(value).slice(0, 400)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function expectGoldenSegments(payload: StatusPayload): void {
  expect(payload.segments.map(({ id, text }) => ({ id, text }))).toEqual(
    GOLDEN.map(({ id, text }) => ({ id, text })),
  );
}

describe("parse-pm worker — bearer guard", () => {
  it("401s every /api route without (or with a wrong) token; /health stays open", async () => {
    expect((await api("auth", "status", undefined, null)).status).toBe(401);
    expect((await api("auth", "run", { budgetUsd: 0.05 }, null)).status).toBe(401);
    expect((await api("auth", "topup", { amountUsd: 0.01 }, "wrong-token")).status).toBe(401);
    expect((await api("auth", "resume", undefined, "wrong-token")).status).toBe(401);
    const health = await worker.fetch(new Request("https://parse-pm.test/health"), env);
    expect(health.status).toBe(200);
  });
});

describe("parse-pm worker — the straight run", () => {
  it("drives the whole plan to done, reproduces the golden, and the audit trail is attenuated", async () => {
    const run = await api("happy", "run", { budgetUsd: 0.05 });
    expect(run.status).toBe(200);
    expect(run.payload.phase).toBe("done");
    expect(run.payload.verified).toEqual({ ok: true, mismatches: [] });
    expect(run.payload.callCount).toBe(4);
    expect(run.payload.spentUsd).toBe(0.03);
    expect(run.payload.ledger.map((entry) => entry.regionId)).toEqual(ALL_REGIONS);
    expectGoldenSegments(run.payload);
    expect(run.payload.segments.map((segment) => segment.label)).toEqual([
      "heading",
      "byline",
      "abstract",
      "body-text",
    ]);
    expect(
      run.payload.log
        .filter((entry) => entry.changed)
        .map((entry) => `${entry.source.phase} ${entry.outcome} ▶ ${entry.to}`),
    ).toEqual([
      "ingest ingested ▶ layout",
      "layout layouted ▶ extract",
      "extract extracted ▶ assemble",
      "assemble assembled ▶ verify",
      "verify verified ▶ done",
    ]);

    // PRIVACY: what actually crossed each child boundary, recorded in workerd.
    expect(run.payload.lastPlayed.length).toBeGreaterThanOrEqual(4);
    for (const child of run.payload.lastPlayed) {
      expect(Object.keys(child.config)).toEqual(["regionId"]);
      expect(child.bindings).toEqual({
        readRegion: "method",
        classify: "method",
        onExtracted: "result",
      });
      const json = JSON.stringify(child);
      expect(json).not.toContain(PDF_MARKER);
      expect(json).not.toContain('"x0"');
      expect(json).not.toContain(FAKE_PROVIDER_KEY);
    }
    // The doc lives in DO storage, never in the status/state surface.
    const statusJson = JSON.stringify(run.payload);
    expect(statusJson).not.toContain(PDF_MARKER);
    expect(statusJson).not.toContain(FAKE_PROVIDER_KEY);
  });
});

describe("parse-pm worker — budget pause, eviction, top-up resume", () => {
  it("parks at paused, survives an instance eviction, resumes without re-buying", async () => {
    // 1. Exhaust the checkbook mid-extract.
    const paused = await api("pause", "run", { budgetUsd: 0.025 });
    expect(paused.payload.phase).toBe("paused");
    expect(paused.payload.spentUsd).toBe(0.017);
    expect(paused.payload.callCount).toBe(2);
    expect(paused.payload.refusals).toEqual([
      { regionId: "abstract-left", ceilingUsd: 0.01, remainingUsd: 0.008 },
    ]);
    expect(paused.payload.checkpoint).toMatchObject({
      seq: 3,
      reason: "budget-refused",
      regionId: "abstract-left",
      completedRegions: ["title", "authors"],
      spentUsd: 0.017,
      callCount: 2,
    });
    expect(paused.payload.ledger.map((entry) => entry.regionId)).toEqual(["title", "authors"]);
    const bootBefore = paused.payload.bootId;

    // 2. EVICTION: the instance dies; SQLite survives.
    await evict("pause");
    const rehydrated = await api("pause", "status");
    expect(rehydrated.status).toBe(200);
    expect(rehydrated.payload.bootId).not.toBe(bootBefore); // a genuinely fresh instance
    expect(rehydrated.payload.phase).toBe("paused");
    expect(rehydrated.payload.checkpoint).toEqual(paused.payload.checkpoint);
    expect(rehydrated.payload.ledger).toEqual(paused.payload.ledger);

    // 3. The human gate: top up, resume from the checkpoint.
    const resumed = await api("pause", "topup", { amountUsd: 0.025 });
    expect(resumed.payload.phase).toBe("done");
    expect(resumed.payload.spentUsd).toBe(0.03);
    expect(resumed.payload.callCount).toBe(4);
    // THE CALL-COUNT ORACLE: four entries, one per region, no duplicates —
    // title and authors were never re-bought across the eviction.
    expect(resumed.payload.ledger.map((entry) => entry.regionId)).toEqual(ALL_REGIONS);
    expectGoldenSegments(resumed.payload);
    // Only the pending regions were played on resume.
    expect(resumed.payload.lastPlayed.map((child) => child.config.regionId)).toEqual([
      "abstract-left",
      "intro-left",
    ]);

    // 4. A further resume is a no-op: nothing fresh mounts at done.
    const again = await api("pause", "resume");
    expect(again.payload.phase).toBe("done");
    expect(again.payload.callCount).toBe(4);
    expect(again.payload.ledger).toEqual(resumed.payload.ledger);
  });
});

describe("parse-pm worker — eviction MID-DRIVE (interrupted fiber recovery)", () => {
  it("recovers an interrupted parse-drive fiber on wake and finishes from the checkpoint", async () => {
    // Start in the background with a provider call that never resolves at
    // abstract-left: the drive commits title+authors, checkpoints #3
    // (before-model-call @ abstract-left), then hangs mid-call.
    const started = await api("evict-mid", "run", {
      budgetUsd: 0.05,
      hangRegions: ["abstract-left"],
      background: true,
    });
    expect(started.status).toBe(200);
    const bootBefore = started.payload.bootId;

    const hung = await until(
      async () => (await api("evict-mid", "status")).payload,
      (payload) =>
        payload.checkpoint?.seq === 3 &&
        payload.checkpoint?.reason === "before-model-call" &&
        payload.checkpoint?.regionId === "abstract-left",
      "checkpoint #3 (metered call in flight)",
    );
    expect(hung.ledger.map((entry) => entry.regionId)).toEqual(["title", "authors"]);
    expect(hung.phase).toBe("extract"); // mid-extract, genuinely in flight

    // EVICTION mid-call: the fiber row stays 'running' in SQLite with no
    // living process behind it.
    await evict("evict-mid");

    // The next wake detects the interrupted fiber (agents' startup scan) and
    // calls onFiberRecovered, which re-drives from the checkpointed state.
    const recovered = await until(
      async () => (await api("evict-mid", "status")).payload,
      (payload) => payload.phase === "done",
      "post-recovery completion",
    );
    expect(recovered.bootId).not.toBe(bootBefore);
    expect(recovered.recovered).toMatchObject({ name: "parse-drive" });
    // Idempotent resume: the hung region was PAID FOR never (its call did not
    // commit), so it is re-called exactly once; completed regions are not.
    expect(recovered.ledger.map((entry) => entry.regionId)).toEqual(ALL_REGIONS);
    expect(recovered.callCount).toBe(4);
    expect(recovered.spentUsd).toBe(0.03);
    expect(recovered.verified).toEqual({ ok: true, mismatches: [] });
    expectGoldenSegments(recovered);
  });
});
