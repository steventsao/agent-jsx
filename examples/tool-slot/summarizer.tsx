/**
 * A SECOND schema-driven child whose input schema matches worker.tsx's — so it
 * satisfies the SAME slot. Different behavior (summarize vs answer), same
 * contract: this is what lets the same coordinator slot be filled by either
 * (see the tool-slot composition in Phase 3 / the README).
 */

import { z } from "zod";
import { agentComponent, type ToolSlotHandle } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";

export const summarizerInput = z.object({ query: z.string().min(1) });
export const summarizerOutput = z.object({ answer: z.string() });

export interface SummarizerProps extends Record<string, unknown> {
  // Optional at the composition site (model-provided when filling a tool slot);
  // the inputSchema is the enforced contract. See worker.tsx.
  query?: string;
  onResult?: (result: { answer: string }) => void;
  /** Slot-fill handle — see worker.tsx. Present only when this fills a tool slot. */
  onCall?: ToolSlotHandle;
}

export interface SummarizerState extends Record<string, unknown> {
  answered: boolean;
}

export const Summarizer = agentComponent<SummarizerProps, SummarizerState, { answer: string }>({
  agentName: "tool-summarizer",
  description: "Summarize the document corpus for a query.",
  displayName: "Summarizer",
  inputSchema: summarizerInput,
  outputSchema: summarizerOutput,
  initialState: { answered: false },
  sampleProps: { query: "sample", onResult: () => {} },
  impl: ({ query, onResult, store }) => {
    const { answered } = useAgentState(store);
    return (
      <>
        {query && !answered && (
          <task
            name={`summarize:${query}`}
            run={async () => ({ answer: `summary of ${query}` })}
            onDone={async (r) => {
              store.set({ answered: true });
              await onResult?.(r as { answer: string });
            }}
          />
        )}
        <prompt>
          <sys p={10}>Summarize the corpus for one query ({query}).</sys>
          <msg p={6}>{answered ? "summarized" : "summarizing…"}</msg>
        </prompt>
      </>
    );
  },
});
