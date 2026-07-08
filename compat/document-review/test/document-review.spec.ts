import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SAMPLE_PDF_B64 } from "../../../fixtures/pdf/sample-pdf.ts";
import worker from "../src/worker.ts";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DOCUMENT_REVIEW: DurableObjectNamespace;
    EXTRACTION_ATTEMPT: DurableObjectNamespace;
  }
}

interface Snapshot {
  status: "waiting_for_document" | "extracting_text" | "running_model" | "needs_review" | "accepted";
  controls: { ok: boolean; tryHarder: boolean };
  latestCandidate: { id: string; label: string; confidence: number } | null;
  acceptedCandidate: { id: string } | null;
  state: {
    source: { channel: string; name: string; pdfB64: string } | null;
    textLayer: string | null;
    requestedAttempts: number;
    candidates: { id: string; confidence: number }[];
    acceptedId: string | null;
    __children?: { name: string; kind: string }[];
  };
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(`https://document-review.test${path}`, init), env);
}

async function json(path: string, init?: RequestInit): Promise<any> {
  const res = await request(path, init);
  expect(res.status).toBeLessThan(500);
  return res.json();
}

const agentPath = (agent: string, path: string) => `/agents/document-review/${encodeURIComponent(agent)}${path}`;
const childPath = (child: { name: string; kind: string }, path: string) =>
  `/agents/${child.kind}/${child.name}${path}`;

async function driveChildren(snapshot: Snapshot): Promise<void> {
  for (const child of snapshot.state.__children ?? []) {
    await json(childPath(child, "/api/drive"), { method: "POST" });
  }
}

async function waitForSnapshot(agent: string, status: Snapshot["status"]): Promise<Snapshot> {
  for (let i = 0; i < 80; i++) {
    const snapshot = (await json(agentPath(agent, "/api/state"))) as Snapshot;
    if (snapshot.status === status) return snapshot;
    await driveChildren(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`document review did not reach ${status}`);
}

const post = (agent: string, path: string, body: Record<string, unknown> = {}) =>
  json(agentPath(agent, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("generated document-review API and page", () => {
  it("serves the generated button page", async () => {
    const res = await request("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Try harder");
    expect(html).toContain("/api/try-harder");
    expect(html).toContain('<script type="module">');
  });

  it("serves a no-content favicon route", async () => {
    const res = await request("/favicon.ico");
    expect(res.status).toBe(204);
  });

  it("runs text extraction, Try harder, and OK through generated routes", async () => {
    const agent = `test-${crypto.randomUUID()}`;

    const empty = (await json(agentPath(agent, "/api/state"))) as Snapshot;
    expect(empty.status).toBe("waiting_for_document");
    expect(empty.state.source).toBeNull();
    expect(empty.controls).toEqual({ ok: false, tryHarder: false });

    const loaded = await post(agent, "/api/channels/document", {
      channel: "document",
      document: { name: "parsebench.pdf", pdfB64: SAMPLE_PDF_B64 },
    });
    expect(loaded.ok).toBe(true);
    expect((loaded.snapshot as Snapshot).state.source?.name).toBe("parsebench.pdf");
    await driveChildren(loaded.snapshot as Snapshot);

    const first = await waitForSnapshot(agent, "needs_review");
    expect(first.latestCandidate?.id).toBe("attempt-1");
    expect(first.controls).toEqual({ ok: true, tryHarder: true });

    const harder = await post(agent, "/api/try-harder");
    expect(harder.ok).toBe(true);
    expect((harder.snapshot as Snapshot).state.requestedAttempts).toBe(2);
    expect(["running_model", "needs_review"]).toContain((harder.snapshot as Snapshot).status);
    await driveChildren(harder.snapshot as Snapshot);

    const second = await waitForSnapshot(agent, "needs_review");
    expect(second.latestCandidate?.id).toBe("attempt-2");
    expect(second.latestCandidate!.confidence).toBeGreaterThan(first.latestCandidate!.confidence);

    const accepted = await post(agent, "/api/ok");
    expect(accepted.ok).toBe(true);
    expect((accepted.snapshot as Snapshot).status).toBe("accepted");
    expect((accepted.snapshot as Snapshot).acceptedCandidate?.id).toBe("attempt-2");
  });
});
