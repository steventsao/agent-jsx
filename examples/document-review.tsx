/**
 * Runnable human-in-the-loop trace.
 *
 * The "client" here is the same shape a React app would bind to buttons:
 * render snapshot, disable invalid actions, call tryHarder() or ok().
 */

import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import { SAMPLE_PDF_B64 } from "../fixtures/pdf/sample-pdf.ts";
import { DocumentReviewAgent, initialDocumentReviewState, synthesizeCandidate } from "./document-review-agent.tsx";
import { DocumentReviewClient } from "./document-review-client.ts";

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

const store = createStore(initialDocumentReviewState);
const agent = mountAgent(<DocumentReviewAgent store={store} />, host);
const client = new DocumentReviewClient(store, agent);

const tick = async (count = 1) => {
  for (let i = 0; i < count; i++) {
    agent.tick();
    await Promise.resolve();
  }
};

const waitFor = async (ready: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for document review state");
};

const print = (label: string) => {
  const snap = client.getSnapshot();
  console.log(`\n${label}`);
  console.log(`  status: ${snap.status}`);
  console.log(`  controls: ok=${snap.controls.ok} tryHarder=${snap.controls.tryHarder}`);
  if (snap.latestCandidate) {
    console.log(
      `  latest: ${snap.latestCandidate.id} ${snap.latestCandidate.label} ` +
        `${Math.round(snap.latestCandidate.confidence * 100)}%`
    );
  }
  if (snap.acceptedCandidate) console.log(`  accepted: ${snap.acceptedCandidate.id}`);
  console.log(`  prompt: ${snap.prompt.split("\n")[0] ?? ""}`);
};

print("initial render");
console.log("\ndocument channel receives parsebench.pdf");
console.log(`  accepted by client facade: ${client.loadDocument({ name: "parsebench.pdf", pdfB64: SAMPLE_PDF_B64 })}`);
await tick();
await waitFor(() => client.getSnapshot().status === "running_model");
print("after text layer and first model pass starts");
await tick(2);
await waitFor(() => client.getSnapshot().status === "needs_review");
print("candidate visible to the client");

console.log("\nclient clicks Try harder");
console.log(`  accepted by client facade: ${client.tryHarder()}`);
await waitFor(() => client.getSnapshot().status === "running_model");
print("after click");
await tick(2);
await waitFor(() => client.getSnapshot().status === "needs_review");
print("stronger candidate returned");

console.log("\nclient clicks OK");
console.log(`  accepted by client facade: ${client.ok()}`);
print("final");

agent.unmount();
