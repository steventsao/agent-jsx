/**
 * A leaf child used as an agentTool target in THINK mode (and a native
 * `subagents:` entry in flue). Its spec carries `description` + zod `inputSchema`
 * — exactly what `agentTool(ResearcherDurable, { description, inputSchema })`
 * needs at the model boundary. In think mode the MODEL calls it; in reconcile
 * mode a parent would spawn it as a standing child.
 */

import { z } from "zod";
import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";

export const researcherInput = z.object({ topic: z.string().min(1) });

export interface ResearcherProps extends Record<string, unknown> {
  topic?: string;
}

export interface ResearcherState extends Record<string, unknown> {
  found: boolean;
}

export const Researcher = agentComponent<ResearcherProps, ResearcherState>({
  agentName: "researcher",
  description: "Research a topic and report findings.",
  displayName: "Researcher",
  inputSchema: researcherInput,
  initialState: { found: false },
  sampleProps: { topic: "general" },
  impl: ({ topic, store }) => {
    const { found } = useAgentState(store);
    return (
      <prompt>
        <sys p={10}>Research the topic ({topic}) and report concise findings.</sys>
        <msg p={6}>{found ? "reported" : "researching…"}</msg>
      </prompt>
    );
  },
});
