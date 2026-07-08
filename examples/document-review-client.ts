import type { AgentHandle } from "../src/agent.ts";
import type { AgentStore } from "../src/state.ts";
import {
  documentReviewSnapshot,
  runDocumentReviewAction,
  type ReviewClientSnapshot,
  type ReviewControls,
  type ReviewStatus,
} from "./document-review-actions.ts";
import type { DocumentReviewState, ExtractionCandidate } from "./document-review-agent.tsx";

export type { ReviewClientSnapshot, ReviewControls, ReviewStatus, ExtractionCandidate };

export class DocumentReviewClient {
  constructor(
    private readonly store: AgentStore<DocumentReviewState>,
    private readonly agent: AgentHandle,
    private readonly budget = 220
  ) {}

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  getSnapshot(): ReviewClientSnapshot {
    return documentReviewSnapshot(this.store.get(), this.agent.prompt(this.budget).text);
  }

  loadDocument(document: { name?: string; mediaType?: string; pdfB64: string }): boolean {
    const result = runDocumentReviewAction(this.store.get(), {
      type: "receiveDocument",
      channel: "document",
      document,
    });
    if (!result.ok) return false;
    this.agent.dispatch(() => {
      this.store.set(() => result.state);
    });
    return true;
  }

  tryHarder(): boolean {
    const result = runDocumentReviewAction(this.store.get(), { type: "tryHarder" });
    if (!result.ok) return false;
    this.agent.dispatch(() => {
      this.store.set(() => result.state);
    });
    return true;
  }

  ok(candidateId = this.getSnapshot().latestCandidate?.id): boolean {
    const result = runDocumentReviewAction(this.store.get(), { type: "ok", candidateId });
    if (!result.ok) return false;
    this.agent.dispatch(() => {
      this.store.set(() => result.state);
    });
    return true;
  }
}
