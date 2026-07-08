/**
 * Recursive boundary discovery.
 *
 * A parent agent's render only records a `<subagent kind=... name=... />`
 * boundary — it never descends into the child's own tree. So a multi-level
 * hierarchy (layout-analyst → layout-reviewer → bbox-extractor) is discovered
 * TRANSITIVELY: evaluate the root at its sample states, read the subagent kinds
 * it renders, resolve each kind to its component module, evaluate THAT child at
 * its own samples, and repeat. Each level gets its own static/dynamic split via
 * the same partial-evaluation `analyze` the root already uses.
 *
 * The output graph is what the emitters consume: one node per reachable agent
 * (de-duped by agentName, root first), each carrying its own analysis and the
 * agentNames of the children IT directly nests. From that the cloudflare
 * emitter derives a per-class `childBinding`, and the flue emitter derives
 * native `subagents:` arrays plus the dynamic-only spawn plan — at every level.
 */

import type { ReactNode } from "react";
import { createStore } from "../store.ts";
import type { AgentSpec } from "../agent-component.tsx";
import { analyze, type Analysis } from "./analyze.ts";
import { evaluateComponent } from "./evaluate.ts";
import { collectInfra } from "../tree.ts";

/** One render input for the static/dynamic analysis: props merged over the
 *  spec's sampleProps, plus the state to render at. */
export interface AgentSample {
  /** Props overriding the spec's sampleProps for this sample (drives prop-gated
   *  fan-out, e.g. a mid-level `.map` over a `page` prop). */
  props?: Record<string, unknown>;
  /** The state to evaluate at. */
  state: Record<string, unknown>;
}

/** A human-authored agent component + where its module lives, plus the sample
 *  render inputs used to split its own static vs dynamic capability. */
export interface AgentModule {
  spec: AgentSpec;
  /** The agentComponent export name (for the generated import). */
  exportName: string;
  /** Import path to the component .tsx from the generated module's directory. */
  importPath: string;
  /** Sample render inputs; defaults to a single sample at `spec.initialState`. */
  samples?: AgentSample[];
}

/** A discovered agent: its module, its own static/dynamic split, and the
 *  agentNames of the children it directly nests. */
export interface AgentNode extends AgentModule {
  analysis: Analysis;
  /** agentNames this node's own render can spawn (its direct child boundaries). */
  directChildren: string[];
  isRoot: boolean;
}

/** An element `{ type: impl, props }`, NOT a call to impl: `analyze` walks it
 *  via `evaluateTree`, which invokes the impl inside `withStaticEval` so
 *  `useAgentState` degenerates to a store read instead of a live React hook. */
function renderSample(spec: AgentSpec, sample: AgentSample): ReactNode {
  return {
    type: spec.impl,
    props: {
      ...(spec.sampleProps ?? {}),
      ...(sample.props ?? {}),
      store: createStore(sample.state),
    },
  } as unknown as ReactNode;
}

/** Analyze one module's OWN render — static vs dynamic capability. */
export function analyzeAgent(mod: AgentModule): Analysis {
  const samples = mod.samples ?? [{ state: mod.spec.initialState as Record<string, unknown> }];
  return analyze((i) => renderSample(mod.spec, samples[i]!), samples.length);
}

/** Distinct subagent kinds across a module's static ∪ dynamic capability —
 *  the agentNames of the children it directly nests, in first-seen order. */
export function directChildKinds(mod: AgentModule): string[] {
  const kinds: string[] = [];
  const samples = mod.samples ?? [{ state: mod.spec.initialState as Record<string, unknown> }];
  for (const sample of samples) {
    for (const root of evaluateComponent(mod.spec.impl, {
      ...(mod.spec.sampleProps ?? {}),
      ...(sample.props ?? {}),
      store: createStore(sample.state),
    } as never)) {
      for (const rec of collectInfra(root)) {
        if (rec.kind === "subagent") {
          const kind = String(rec.config.kind);
          if (!kinds.includes(kind)) kinds.push(kind);
        }
      }
    }
  }
  return kinds;
}

/**
 * Discover the reachable agent graph from a root, following subagent boundaries
 * transitively and resolving each child kind against `registry`. De-duped by
 * agentName (root first, then breadth-first). An unresolved kind (no matching
 * module in the registry) is skipped — the caller composed a boundary whose
 * component it did not register.
 */
export function discoverAgents(root: AgentModule, registry: AgentModule[]): AgentNode[] {
  const byName = new Map<string, AgentModule>();
  for (const m of [root, ...registry]) {
    if (!byName.has(m.spec.agentName)) byName.set(m.spec.agentName, m);
  }

  const nodes: AgentNode[] = [];
  const visited = new Set<string>();
  const queue: { mod: AgentModule; isRoot: boolean }[] = [{ mod: root, isRoot: true }];

  while (queue.length > 0) {
    const { mod, isRoot } = queue.shift()!;
    if (visited.has(mod.spec.agentName)) continue;
    visited.add(mod.spec.agentName);

    const directChildren = directChildKinds(mod);
    nodes.push({ ...mod, analysis: analyzeAgent(mod), directChildren, isRoot });

    for (const kind of directChildren) {
      const childMod = byName.get(kind);
      if (childMod && !visited.has(kind)) queue.push({ mod: childMod, isRoot: false });
    }
  }
  return nodes;
}
