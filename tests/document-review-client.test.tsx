import { describe, expect, it } from "bun:test";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import { SAMPLE_PDF_B64 } from "../fixtures/pdf/sample-pdf.ts";
import {
  DocumentReviewAgent,
  initialDocumentReviewState,
  synthesizeCandidate,
  type DocumentReviewState,
} from "../examples/document-review-agent.tsx";
import { DocumentReviewClient } from "../examples/document-review-client.ts";

function setup() {
  const host = new SimHost({
    statusAt: () => 200,
    subagentLatency: 2,
    subagentResult: (record) =>
      synthesizeCandidate({
        attempt: record.config.attempt as number,
        model: record.config.model as string,
        label: record.config.label as string,
        textLayer: record.config.textLayer as string,
      }),
  });
  const store = createStore<DocumentReviewState>(initialDocumentReviewState);
  const agent = mountAgent(<DocumentReviewAgent store={store} />, host, { quiet: true });
  const client = new DocumentReviewClient(store, agent);
  return { agent, client, host, store };
}

async function tick(agent: ReturnType<typeof mountAgent>, count = 1) {
  for (let i = 0; i < count; i++) {
    agent.tick();
    await Promise.resolve();
  }
}

async function waitFor(assertion: () => void, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
}

describe("document review human-input client", () => {
  it("waits for a document channel message before extracting text", () => {
    const { agent, client, host } = setup();
    expect(client.getSnapshot().status).toBe("waiting_for_document");
    expect(client.getSnapshot().controls).toEqual({ ok: false, tryHarder: false });
    expect([...host.liveRecords.keys()]).toEqual([]);

    expect(client.loadDocument({ name: "parsebench.pdf", pdfB64: SAMPLE_PDF_B64 })).toBe(true);
    expect(client.getSnapshot().status).toBe("extracting_text");
    expect(client.getSnapshot().controls).toEqual({ ok: false, tryHarder: false });
    expect([...host.liveRecords.keys()]).toEqual(["task:extract:text-layer"]);
    agent.unmount();
  });

  it("queues exactly one stronger attempt per Try harder click and accepts on OK", async () => {
    const { agent, client, host, store } = setup();

    expect(client.loadDocument({ name: "parsebench.pdf", pdfB64: SAMPLE_PDF_B64 })).toBe(true);
    await tick(agent);
    await waitFor(() => expect(client.getSnapshot().status).toBe("running_model"));
    expect([...host.liveRecords.keys()]).toEqual(["subagent:extract:attempt-1"]);

    await tick(agent, 2);
    await waitFor(() => expect(client.getSnapshot().status).toBe("needs_review"));
    let snap = client.getSnapshot();
    expect(snap.latestCandidate?.id).toBe("attempt-1");
    expect(snap.controls).toEqual({ ok: true, tryHarder: true });
    expect([...host.liveRecords.keys()]).toEqual([]);

    expect(client.tryHarder()).toBe(true);
    expect(client.tryHarder()).toBe(false);
    await waitFor(() => expect(client.getSnapshot().status).toBe("running_model"));
    snap = client.getSnapshot();
    expect(store.get().requestedAttempts).toBe(2);
    expect([...host.liveRecords.keys()]).toEqual(["subagent:extract:attempt-2"]);

    await tick(agent, 2);
    snap = client.getSnapshot();
    expect(snap.status).toBe("needs_review");
    expect(snap.latestCandidate?.id).toBe("attempt-2");
    expect(snap.latestCandidate?.confidence).toBeGreaterThan(store.get().candidates[0]!.confidence);

    expect(client.ok()).toBe(true);
    snap = client.getSnapshot();
    expect(snap.status).toBe("accepted");
    expect(snap.acceptedCandidate?.id).toBe("attempt-2");
    expect(snap.controls).toEqual({ ok: false, tryHarder: false });
    expect(client.tryHarder()).toBe(false);
    expect([...host.liveRecords.keys()]).toEqual([]);
    expect(agent.prompt(240).text).toContain("Accepted attempt-2");

    agent.unmount();
  });
});
