/**
 * Tool-slot discovery: read a composition's slot bindings.
 *
 * A tool-slot provider (spec.toolSlot) passes its render-prop continuation a
 * capability SLOT HANDLE — a marker (see agent-component.tsx). Binding that
 * handle to a child boundary's prop (`<Worker onCall={handle} />`) registers that
 * child as a model tool named after the PROP KEY. Evaluating the composition with
 * expansion on records the child boundary with the handle in its config; this
 * module reads those handle-carrying records back out. Recognition is by the
 * handle's TYPE, never by guessing from syntax — the same discriminator the
 * evaluator uses to tell a slot continuation from an output continuation.
 *
 * The cloudflare emitter's agentTools mode consumes these bindings to emit a
 * `getTools()` block (agents 0.17 `agentTool`); the flue target exposes the same
 * children as a native `subagents:` roster.
 */

import { isToolSlotHandle } from "../agent-component.tsx";
import { withOutputs } from "../store.ts";
import { collectInfra } from "../tree.ts";
import { evaluateTree } from "./evaluate.ts";

export interface ToolSlotBinding {
  /** The prop KEY the handle was bound to → the model-tool name. */
  toolName: string;
  /** agentName of the child that fills the slot (the agentTool target). */
  childKind: string;
  /** agentName of the slot PROVIDER — which agent's getTools this belongs to. */
  provider: string;
  /** JSX host identity retained for deterministic adapters and diagnostics. */
  stableId: string;
}

/**
 * Evaluate a composition element with sample/slot expansion ON and collect its
 * tool-slot bindings: every subagent record carrying a slot-handle-valued prop.
 */
export function discoverToolSlots(element: unknown): ToolSlotBinding[] {
  const bindings: ToolSlotBinding[] = [];
  const roots = withOutputs({ outputs: {}, setOutput: () => {}, expandSamples: true }, () =>
    evaluateTree(element)
  );
  for (const root of roots) {
    for (const rec of collectInfra(root)) {
      if (rec.kind !== "subagent") continue;
      for (const [key, value] of Object.entries(rec.config)) {
        if (key === "kind") continue;
        if (isToolSlotHandle(value)) {
          bindings.push({
            toolName: key,
            childKind: String(rec.config.kind),
            provider: value.provider,
            stableId: rec.name,
          });
        }
      }
    }
  }
  return bindings;
}
