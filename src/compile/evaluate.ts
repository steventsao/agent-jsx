/**
 * React-free evaluation: walk a React element tree by hand, producing the
 * same HostNode shape the reconciler commits.
 *
 * Why this is sound: agent components are PURE functions of (props, state) —
 * no effects, no refs, and the only hook (useAgentState) degenerates to a
 * store read under withStaticEval. And the host reconciles by re-deriving
 * FULL desired state every commit, diffing by (kind, name) — so React's
 * incremental fiber diffing buys nothing at runtime for a few dozen infra
 * nodes. React earns its keep at DEV time (StrictMode, keys, testing, the
 * mental model); the compiled artifact only needs this ~70-line walker.
 *
 * examples/compile.tsx asserts parity: React render+commit and this walker
 * produce byte-identical desired infra and prompt blocks.
 */

import type { HostNode } from "../tree.ts";
import { withStaticEval } from "../store.ts";

const FRAGMENT = Symbol.for("react.fragment");

function isElement(x: unknown): x is { type: unknown; props: Record<string, unknown> } {
  return typeof x === "object" && x !== null && "type" in x && "props" in x;
}

function walk(node: unknown, out: HostNode[]): void {
  if (node == null || typeof node === "boolean") return;

  if (typeof node === "string" || typeof node === "number") {
    out.push({ type: "text", props: { value: String(node) }, children: [] });
    return;
  }

  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return;
  }

  if (!isElement(node)) return;

  const { type, props } = node;

  if (type === FRAGMENT) {
    walk(props.children, out);
    return;
  }

  if (typeof type === "function") {
    // A component: call it (pure) and keep walking. This is the step React's
    // renderer does with fibers; without state/effects it's a function call.
    walk((type as (p: unknown) => unknown)(props), out);
    return;
  }

  if (typeof type === "string") {
    const { children, ...rest } = props as { children?: unknown };
    const host: HostNode = { type, props: rest, children: [] };
    walk(children, host.children);
    out.push(host);
    return;
  }
}

/** Evaluate an element tree to committed-equivalent host nodes, no React. */
export function evaluateTree(element: unknown): HostNode[] {
  return withStaticEval(() => {
    const out: HostNode[] = [];
    walk(element, out);
    return out;
  });
}

/** Evaluate a component function with props — the call happens INSIDE static
 *  eval, so useAgentState degenerates to a store read (no React, no hooks). */
export function evaluateComponent<P>(component: (props: P) => unknown, props: P): HostNode[] {
  return evaluateTree({ type: component, props });
}
