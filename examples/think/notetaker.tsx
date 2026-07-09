/**
 * A THINK-mode root that exercises BOTH getTools sources at once:
 *   - a STATIC <tool> (`saveNote`, always rendered) → an AI-SDK `tool(...)`;
 *   - a PLAINLY nested child boundary (`<Researcher>`, not slot-bound) →
 *     `agentTool(ResearcherDurable, …)` named by the child's KIND ("researcher").
 *
 * The same file drives the flue Phase-3 gap-closer: its static <tool> emits as
 * `tools: [defineTool(...)]` and the child as `subagents: [researcherProfile]`.
 * <sensor>/<schedule>/<task> are deliberately absent — they are think-UNSUPPORTED
 * (reconcile's job); see docs/think-target.md.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { Researcher } from "./researcher.tsx";

export interface NotetakerState extends Record<string, unknown> {
  notes: number;
}

export const Notetaker = agentComponent<Record<string, unknown>, NotetakerState>({
  agentName: "notetaker",
  description: "Take notes and delegate research to a researcher.",
  initialState: { notes: 0 },
  sampleProps: {},
  impl: ({ store }) => {
    const { notes } = useAgentState(store);
    return (
      <>
        {/* STATIC tool: always available → getTools()["saveNote"] = tool(...) */}
        <tool
          name="saveNote"
          description="Save a note to the notebook."
          run={async (input) => {
            store.set({ notes: (store.get().notes ?? 0) + 1 });
            return `saved: ${JSON.stringify(input)}`;
          }}
        />
        {/* PLAIN child boundary → agentTool named by kind "researcher". */}
        <Researcher name="researcher" topic="general" />
        <prompt>
          <sys p={10}>Take notes with saveNote; delegate research to the researcher.</sys>
          <msg p={6}>{notes} notes saved.</msg>
        </prompt>
      </>
    );
  },
});
