/**
 * A TOOL-SLOT PROVIDER that NAMES NO CHILD. `toolSlot: true` means a boundary
 * carrying a function child receives a capability slot HANDLE (a marker), not an
 * emitted output. The composition site binds that handle to a child boundary's
 * prop, and the prop KEY becomes a model-tool dispatching that child:
 *
 *   <Coordinator name="coord">{(handleCall) => <Worker onCall={handleCall} />}</Coordinator>
 *
 * compiles (agentTools mode) to, in CoordinatorDurable:
 *
 *   getTools() { return { onCall: agentTool(ToolWorkerDurable, {
 *     description: Worker.spec.description, inputSchema: Worker.spec.inputSchema }) } }
 *
 * Any agent whose spec satisfies the slot fills it — the SAME Coordinator,
 * composed with <Summarizer onCall={handleCall} /> instead, binds the summarizer.
 * Hierarchy comes from the composition site, not from this file.
 */

import { agentComponent, type ToolSlotHandle } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";

export interface CoordinatorState extends Record<string, unknown> {
  turns: number;
}

// O = ToolSlotHandle: a tool-slot provider's continuation receives a capability
// handle (not an emitted output), so `<Coordinator>{(handle) => …}</Coordinator>`
// types the handle correctly at the composition site.
export const Coordinator = agentComponent<Record<string, unknown>, CoordinatorState, ToolSlotHandle>({
  agentName: "coordinator",
  description: "Coordinate work by delegating to a single bound worker tool.",
  toolSlot: true,
  initialState: { turns: 0 },
  impl: ({ store }) => {
    const { turns } = useAgentState(store);
    return (
      <prompt>
        <sys p={10}>Coordinate the task; call the bound worker tool when you need it.</sys>
        <msg p={6}>{turns} turns so far.</msg>
      </prompt>
    );
  },
});
