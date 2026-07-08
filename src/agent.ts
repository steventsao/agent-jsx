/**
 * The public seam: mount a component tree as an agent's control plane.
 *
 * mountAgent(<Uptime sites={...}/>, host)
 *   → React renders the tree
 *   → every commit sweeps desired infra into host.reconcile()
 *   → world events call handler props inside flushSync, so state changes
 *     re-render and re-reconcile synchronously and deterministically
 *   → think() assembles the CURRENT committed <prompt> subtree under a
 *     token budget (priompt semantics) — the context window is derived
 *     state, never accumulated by hand.
 */

import type { ReactNode } from "react";
import { collectPrompt, createFiber, type Fiber } from "./reconciler.ts";
import { renderPrompt, type RenderedPrompt } from "./prompt.ts";
import type { AgentHost, HostOp } from "./types.ts";
import { formatOps, SimHost } from "./sim-host.ts";

export interface AgentHandle {
  host: AgentHost;
  /** Re-render with new root props ("the world changed from outside"). */
  update(element: ReactNode): void;
  /** Apply a client/user event and immediately reconcile the resulting tree. */
  dispatch<R>(fn: () => R): R;
  /** Advance the simulated world one tick (SimHost only). */
  tick(): void;
  /** Render the agent's current context window under a token budget. */
  prompt(budget: number): RenderedPrompt;
  /** One model turn over the rendered context (mock — see docs for real). */
  think(budget?: number): string;
  unmount(): void;
  fiber: Fiber;
}

export function mountAgent(
  element: ReactNode,
  host: AgentHost,
  opts: { quiet?: boolean } = {}
): AgentHandle {
  const onOps = (ops: HostOp[]) => {
    if (opts.quiet) return;
    const t = host instanceof SimHost ? host.t : 0;
    for (const line of formatOps(ops, t)) console.log(line);
  };

  const fiber = createFiber(host, onOps);
  fiber.update(element);

  return {
    host,
    fiber,
    update: (el) => fiber.update(el),
    dispatch: (fn) => fiber.flush(fn),
    tick: () => {
      if (!(host instanceof SimHost)) throw new Error("tick() is for SimHost demos");
      host.tick(fiber.flush);
    },
    prompt: (budget) => renderPrompt(collectPrompt(fiber.container.children), budget),
    think: (budget = 120) => {
      const rendered = renderPrompt(collectPrompt(fiber.container.children), budget);
      // Mock model turn: enough to show the prompt driving behavior.
      const incident = rendered.included.find((b) => b.text.includes("INCIDENT"));
      const reply = incident
        ? `⚠ acting on: ${incident.text.slice(0, 70)}`
        : "all clear — routine report";
      return `${reply}   (context: ${rendered.usedTokens}/${budget} tokens, ${rendered.included.length} blocks, ${rendered.excluded.length} pruned)`;
    },
    unmount: () => fiber.unmount(),
  };
}
