/**
 * A root that composes the two schema-driven children as NORMAL boundaries
 * (state-gated on a query). It exists to make the schema contract visible in
 * committed fixtures: the emitted cloudflare classes carry each child's
 * `@boundarySchema` doc, and the flue profiles carry each child's `description`.
 * (The tool-SLOT form of this composition — where a child fills a coordinator's
 * model-tool slot — is coordinator.tsx.)
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { Worker } from "./worker.tsx";
import { Summarizer } from "./summarizer.tsx";

export interface ResearchDeskState extends Record<string, unknown> {
  /** The query to fan out; null at rest. */
  query: string | null;
  /** Answers folded up from each child, keyed by role. */
  results: Record<string, string>;
}

export const initialResearchDeskState: ResearchDeskState = { query: null, results: {} };

export const ResearchDesk = agentComponent<Record<string, unknown>, ResearchDeskState>({
  agentName: "research-desk",
  description: "Fan a query out to a researcher and a summarizer, then collect both answers.",
  initialState: initialResearchDeskState,
  impl: ({ store }) => {
    const { query, results } = useAgentState(store);
    const fold = (who: string) => (r: { answer: string }) =>
      store.set((s) => ({ ...s, results: { ...s.results, [who]: r.answer } }));

    return (
      <>
        {query && <Worker name="research" query={query} onResult={fold("worker")} />}
        {query && <Summarizer name="summary" query={query} onResult={fold("summarizer")} />}
        <prompt>
          <sys p={10}>Research desk — delegate a query to both a researcher and a summarizer.</sys>
          <msg p={6}>{query ? `${Object.keys(results).length}/2 answers for "${query}"` : "idle"}</msg>
        </prompt>
      </>
    );
  },
});
