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
import { withOutputs, type AgentStore, type OutputsContext } from "./store.ts";

/** Duck-type the root store off the mounted element's `store` prop — the seam
 *  the continuation-outputs context writes into to trigger a re-render. */
function readStore(element: ReactNode): AgentStore<Record<string, unknown>> | null {
  const store = (element as { props?: { store?: unknown } } | null)?.props?.store as
    | { get?: unknown; set?: unknown }
    | undefined;
  return store && typeof store.get === "function" && typeof store.set === "function"
    ? (store as AgentStore<Record<string, unknown>>)
    : null;
}

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

  // Continuation-outputs context, backed by the root store. `outputs` reads the
  // reserved `__outputs` slot LIVE (a getter — so a re-render mid-flush sees an
  // output written earlier in the same turn); `setOutput` merges into that slot,
  // and the store change re-renders the tree (useSyncExternalStore) within the
  // current flush, expanding the continuation and reconciling its grandchildren.
  let store = readStore(element);
  const ctx: OutputsContext = {
    get outputs() {
      return (store?.get() as { __outputs?: Record<string, unknown> } | undefined)?.__outputs ?? {};
    },
    setOutput: (name, output) => {
      store?.set(
        (s) =>
          ({
            ...(s as Record<string, unknown>),
            __outputs: {
              ...((s as { __outputs?: Record<string, unknown> }).__outputs ?? {}),
              [name]: output,
            },
          }) as never
      );
    },
  };

  // Every render/dispatch/tick runs inside the context, so the boundary wrapper
  // reads outputs and injects `__emit` uniformly across the React commit path.
  const render = (el: ReactNode) => {
    store = readStore(el) ?? store;
    withOutputs(ctx, () => fiber.update(el));
  };
  render(element);

  return {
    host,
    fiber,
    update: (el) => render(el),
    dispatch: (fn) => withOutputs(ctx, () => fiber.flush(fn)),
    tick: () => {
      if (!(host instanceof SimHost)) throw new Error("tick() is for SimHost demos");
      withOutputs(ctx, () => host.tick(fiber.flush));
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
