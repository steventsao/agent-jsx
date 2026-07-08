/**
 * Human-in-the-loop document review.
 *
 * The parent owns the review state and the client-facing actions. The child
 * owns one extraction attempt. A user clicking "Try harder" does not call a
 * model directly; it mutates durable state, the parent re-renders, and exactly
 * one new child attempt appears.
 */

import { agentComponent } from "../src/agent-component.tsx";
import { useAgentState, type AgentStore } from "../src/state.ts";
import { b64ToBytes, extractTextLayer } from "../targets/pdf/core/extract.ts";

export interface DocumentPayload {
  title: string;
  summary: string;
  extractedFacts: string[];
  openQuestions: string[];
}

export interface ExtractionCandidate {
  id: string;
  attempt: number;
  model: string;
  label: string;
  confidence: number;
  payload: DocumentPayload;
  note: string;
}

export interface ModelTier {
  model: string;
  label: string;
  strategy: string;
}

export interface DocumentSource {
  channel: "document";
  name: string;
  mediaType: string;
  pdfB64: string;
}

export const MODEL_LADDER: ModelTier[] = [
  {
    model: "google/gemini-3-flash",
    label: "Gemini Flash 3",
    strategy: "fast pass over deterministic text-layer extraction",
  },
  {
    model: "google/gemini-3-pro",
    label: "Gemini Pro",
    strategy: "cross-check headings, equations, and table-like spans",
  },
  {
    model: "google/gemini-3-ultra",
    label: "Gemini Ultra",
    strategy: "slow adjudication pass with stricter uncertainty reporting",
  },
];

export interface DocumentReviewState extends Record<string, unknown> {
  source: DocumentSource | null;
  textLayer: string | null;
  requestedAttempts: number;
  candidates: ExtractionCandidate[];
  acceptedId: string | null;
}

export const initialDocumentReviewState: DocumentReviewState = {
  source: null,
  textLayer: null,
  requestedAttempts: 1,
  candidates: [],
  acceptedId: null,
};

export function modelForAttempt(attempt: number): ModelTier {
  return MODEL_LADDER[Math.min(attempt - 1, MODEL_LADDER.length - 1)]!;
}

function firstWords(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().split(" ").slice(0, limit).join(" ");
}

export function synthesizeCandidate(input: {
  attempt: number;
  model: string;
  label: string;
  textLayer: string;
}): ExtractionCandidate {
  const prefix = firstWords(input.textLayer, 18) || "No selectable text found";
  const confidence = Math.min(0.54 + input.attempt * 0.16, 0.94);
  const facts = [
    `Text layer length: ${input.textLayer.length} chars`,
    `Opening span: ${prefix}`,
  ];
  if (input.attempt >= 2) facts.push("Second pass preserved reading order across detected spans");
  if (input.attempt >= 3) facts.push("Final pass marked residual ambiguity instead of guessing");

  const openQuestions =
    input.attempt === 1
      ? ["Need stronger table/figure reconciliation"]
      : input.attempt === 2
        ? ["Need final uncertainty pass before accepting"]
        : [];

  return {
    id: `attempt-${input.attempt}`,
    attempt: input.attempt,
    model: input.model,
    label: input.label,
    confidence,
    payload: {
      title: prefix,
      summary:
        input.attempt === 1
          ? "Fast text-layer extraction produced a usable but incomplete structured read."
          : input.attempt === 2
            ? "A stronger pass reconciled the text layer with layout-sensitive spans."
            : "The final pass is ready for human acceptance unless the reviewer sees a domain issue.",
      extractedFacts: facts,
      openQuestions,
    },
    note: `${input.label}: ${modelForAttempt(input.attempt).strategy}`,
  };
}

export interface ExtractionAttemptProps extends Record<string, unknown> {
  attempt: number;
  model: string;
  label: string;
  textLayer: string;
  onResult: (candidate: ExtractionCandidate) => void | Promise<void>;
}

interface ExtractionAttemptState extends Record<string, unknown> {
  started: boolean;
}

export const ExtractionAttempt = agentComponent<ExtractionAttemptProps, ExtractionAttemptState>({
  agentName: "extraction-attempt",
  initialState: { started: false },
  sampleProps: {
    attempt: 1,
    model: MODEL_LADDER[0]!.model,
    label: MODEL_LADDER[0]!.label,
    textLayer: "sample text layer",
    onResult: () => {},
  },
  impl: ({ attempt, model, label, textLayer, onResult, store }) => {
    const { started } = useAgentState(store);
    return (
      <>
        {!started && (
          <task
            name={`model-pass:${attempt}`}
            run={() => {
              store.set({ started: true });
              return synthesizeCandidate({ attempt, model, label, textLayer });
            }}
            onDone={(candidate: unknown) => onResult(candidate as ExtractionCandidate)}
          />
        )}
        <prompt>
          <sys p={10}>
            Run attempt {attempt} with {label}. Use the deterministic text layer as evidence; do
            not invent fields that are not supported by the source.
          </sys>
          <msg p={7}>Model id: {model}. Text chars: {textLayer.length}. Started: {String(started)}.</msg>
        </prompt>
      </>
    );
  },
});

export function DocumentReviewAgent({ store }: { store: AgentStore<DocumentReviewState> }) {
  const { source, textLayer, requestedAttempts, candidates, acceptedId } = useAgentState(store);
  const accepted = acceptedId ? candidates.find((c) => c.id === acceptedId) : undefined;
  const pendingAttempt =
    source && textLayer && !accepted && candidates.length < requestedAttempts
      ? candidates.length + 1
      : null;
  const tier = pendingAttempt ? modelForAttempt(pendingAttempt) : null;
  const pendingTextLayer = pendingAttempt ? textLayer : null;

  const recordCandidate = (candidate: ExtractionCandidate) => {
    store.set((s) => {
      if (s.candidates.some((c) => c.id === candidate.id)) return s;
      return { ...s, candidates: [...s.candidates, candidate] };
    });
  };

  return (
    <>
      {source && !textLayer && (
        <task
          name="extract:text-layer"
          run={() => extractTextLayer(b64ToBytes(source.pdfB64), { x0: 0, y0: 0, x1: 1, y1: 1 })}
          onDone={(text: unknown) => store.set({ textLayer: String(text) })}
        />
      )}

      {pendingAttempt && tier && pendingTextLayer !== null && (
        <ExtractionAttempt
          key={pendingAttempt}
          name={`extract:attempt-${pendingAttempt}`}
          attempt={pendingAttempt}
          model={tier.model}
          label={tier.label}
          textLayer={pendingTextLayer}
          onResult={recordCandidate}
        />
      )}

      <prompt>
        <sys p={10}>
          Human review loop over one PDF received from the document channel. Start with
          deterministic text-layer extraction, then run increasingly expensive Gemini passes only
          when the user asks to try harder.
        </sys>
        {!source && <msg p={9}>Waiting for the document channel before starting extraction.</msg>}
        {source && !textLayer && (
          <msg p={9}>Extracting text layer from {source.name} before any model attempt.</msg>
        )}
        {pendingAttempt && tier && (
          <msg p={9}>
            Attempt {pendingAttempt} running on {tier.label}; waiting before showing controls again.
          </msg>
        )}
        {!accepted && textLayer && !pendingAttempt && candidates.length > 0 && (
          <msg p={9}>
            Awaiting human input: OK accepts {candidates.at(-1)!.id}; Try harder requests the next
            model tier.
          </msg>
        )}
        {accepted && (
          <msg p={9}>
            Accepted {accepted.id} from {accepted.label} at confidence{" "}
            {(accepted.confidence * 100).toFixed(0)}%.
          </msg>
        )}
        {candidates.map((candidate) => (
          <msg key={candidate.id} prel={-candidate.attempt}>
            candidate {candidate.id}: {candidate.label}, confidence{" "}
            {(candidate.confidence * 100).toFixed(0)}%, open questions{" "}
            {candidate.payload.openQuestions.length}.
          </msg>
        ))}
      </prompt>
    </>
  );
}

/**
 * The root declared via `agentComponent(spec)` like every child — the single
 * source the compiler analyzes (state shape + initial state + impl). The live
 * SimHost example and client test drive the DocumentReviewAgent component
 * directly; the emitter consumes this spec.
 */
export const documentReviewAgent = agentComponent<Record<string, never>, DocumentReviewState>({
  agentName: "document-review",
  initialState: initialDocumentReviewState,
  impl: DocumentReviewAgent,
});
