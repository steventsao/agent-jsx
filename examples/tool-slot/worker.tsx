/**
 * A SCHEMA-DRIVEN child agent. Its spec carries zod `inputSchema`/`outputSchema`
 * plus `description`/`displayName` — so the boundary VALIDATES the serializable
 * input it is composed with (and the output it emits), and the compiler EMBEDS
 * the contract in the generated artifacts (the cloudflare class doc's
 * @boundarySchema line, the flue profile's `description`). Any agent whose spec
 * satisfies the same input schema can fill the same slot (see summarizer.tsx).
 */

import { z } from "zod";
import { agentComponent, type ToolSlotHandle } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";

/** The serializable INPUT contract — validated at the boundary as `setProps`. */
export const workerInput = z.object({ query: z.string().min(1) });
/** The OUTPUT contract — validated before it lands in the parent's __outputs. */
export const workerOutput = z.object({ answer: z.string() });

export interface WorkerProps extends Record<string, unknown> {
  // Optional at the COMPOSITION site: a normal parent passes them; when this
  // agent fills a tool slot, the input arrives from the MODEL at call time (the
  // inputSchema is the real, enforced contract either way).
  query?: string;
  onResult?: (result: { answer: string }) => void;
  /** When this agent FILLS a coordinator's tool slot, the composition binds the
   *  provider's capability handle here (`<Worker onCall={handleCall} />`); the
   *  prop key names the model tool. Absent for a normal (non-slot) composition. */
  onCall?: ToolSlotHandle;
}

export interface WorkerState extends Record<string, unknown> {
  answered: boolean;
}

export const Worker = agentComponent<WorkerProps, WorkerState, { answer: string }>({
  agentName: "tool-worker",
  description: "Answer a research query from the document corpus.",
  displayName: "Researcher",
  inputSchema: workerInput,
  outputSchema: workerOutput,
  initialState: { answered: false },
  sampleProps: { query: "sample", onResult: () => {} },
  impl: ({ query, onResult, store }) => {
    const { answered } = useAgentState(store);
    return (
      <>
        {query && !answered && (
          <task
            name={`answer:${query}`}
            run={async () => ({ answer: `re: ${query}` })}
            onDone={async (r) => {
              store.set({ answered: true });
              await onResult?.(r as { answer: string });
            }}
          />
        )}
        <prompt>
          <sys p={10}>Answer one research query ({query}).</sys>
          <msg p={6}>{answered ? "answered" : "researching…"}</msg>
        </prompt>
      </>
    );
  },
});
