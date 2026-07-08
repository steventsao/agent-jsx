import {
  MODEL_LADDER,
  initialDocumentReviewState,
  type DocumentSource,
  type DocumentReviewState,
  type ExtractionCandidate,
} from "./document-review-agent.tsx";

export type ReviewStatus =
  | "waiting_for_document"
  | "extracting_text"
  | "running_model"
  | "needs_review"
  | "accepted";

export interface ReviewControls {
  ok: boolean;
  tryHarder: boolean;
}

export interface ReviewClientSnapshot {
  state: DocumentReviewState;
  status: ReviewStatus;
  latestCandidate: ExtractionCandidate | null;
  acceptedCandidate: ExtractionCandidate | null;
  controls: ReviewControls;
  prompt: string;
}

export type DocumentReviewAction =
  | {
      type: "receiveDocument";
      channel?: "document";
      document?: { name?: string; mediaType?: string; pdfB64?: string };
    }
  | { type: "tryHarder" }
  | { type: "ok"; candidateId?: string }
  | { type: "reset" };

export interface DocumentReviewActionResult {
  ok: boolean;
  state: DocumentReviewState;
  reason?: string;
}

function normalizePdfB64(input: string): string {
  const trimmed = input.trim();
  const comma = trimmed.indexOf(",");
  return trimmed.startsWith("data:") && comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
}

function documentSource(action: Extract<DocumentReviewAction, { type: "receiveDocument" }>): DocumentSource | null {
  const pdfB64 = normalizePdfB64(String(action.document?.pdfB64 ?? ""));
  if (!pdfB64) return null;
  return {
    channel: "document",
    name: action.document?.name || "uploaded.pdf",
    mediaType: action.document?.mediaType || "application/pdf",
    pdfB64,
  };
}

export function documentReviewSnapshot(
  state: DocumentReviewState,
  prompt: string
): ReviewClientSnapshot {
  const latestCandidate = state.candidates.at(-1) ?? null;
  const acceptedCandidate = state.acceptedId
    ? state.candidates.find((candidate) => candidate.id === state.acceptedId) ?? null
    : null;
  const waitingForDocument = state.source === null;
  const pendingText = !waitingForDocument && state.textLayer === null;
  const pendingModel =
    state.textLayer !== null &&
    !acceptedCandidate &&
    state.candidates.length < state.requestedAttempts;
  const status: ReviewStatus = acceptedCandidate
    ? "accepted"
    : waitingForDocument
      ? "waiting_for_document"
      : pendingText
      ? "extracting_text"
      : pendingModel
        ? "running_model"
        : "needs_review";

  return {
    state,
    status,
    latestCandidate,
    acceptedCandidate,
    controls: {
      ok: status === "needs_review" && latestCandidate !== null,
      tryHarder:
        status === "needs_review" &&
        latestCandidate !== null &&
        state.requestedAttempts < MODEL_LADDER.length,
    },
    prompt,
  };
}

export function runDocumentReviewAction(
  state: DocumentReviewState,
  action: DocumentReviewAction
): DocumentReviewActionResult {
  if (action.type === "reset") return { ok: true, state: { ...initialDocumentReviewState } };

  if (action.type === "receiveDocument") {
    const source = documentSource(action);
    if (!source) return { ok: false, state, reason: "document channel requires pdfB64" };
    return {
      ok: true,
      state: {
        ...initialDocumentReviewState,
        source,
      },
    };
  }

  const snapshot = documentReviewSnapshot(state, "");
  if (action.type === "tryHarder") {
    if (!snapshot.controls.tryHarder) {
      return { ok: false, state, reason: "try harder is only available while a candidate is awaiting review" };
    }
    return { ok: true, state: { ...state, requestedAttempts: state.requestedAttempts + 1 } };
  }

  const candidateId = action.candidateId ?? snapshot.latestCandidate?.id;
  if (!snapshot.controls.ok || !candidateId) {
    return { ok: false, state, reason: "ok is only available while a candidate is awaiting review" };
  }
  if (!state.candidates.some((candidate) => candidate.id === candidateId)) {
    return { ok: false, state, reason: `unknown candidate ${candidateId}` };
  }
  return { ok: true, state: { ...state, acceptedId: candidateId } };
}
