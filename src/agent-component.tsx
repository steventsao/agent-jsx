/**
 * Agent boundaries as components — the composition contract:
 *
 *   <Investigator name={`investigate:${site}`} site={site} onResult={record} />
 *
 * - Nesting = parent/child agent relationship (who spawns whom).
 * - Serializable props = the child's input. A parent re-render that changes
 *   them compiles to `child.setProps(...)` — props flow ACROSS the DO/actor
 *   boundary the same way they flow down a React tree.
 * - Function props = the child's line back to the parent. They compile to
 *   generated RPC: child calls what looks like `props.onResult(x)`; codegen
 *   routes it to a generated dispatcher method on the parent, which invokes
 *   the FRESHEST closure from the parent's latest render.
 *
 * You write agent component files. The compiler owns classes, bindings,
 * migrations, and RPC stubs — the glue flue and cloudflare/agents make you
 * write by hand today.
 *
 * Live (SimHost/React) semantics: the boundary renders the <subagent>
 * intrinsic, so mount/unmount/update behavior is identical to before —
 * the child's INTERNALS are its own tree, never the parent's.
 */

import type { ReactNode } from "react";
import type { AgentStore } from "./store.ts";

/** What a child agent's implementation receives at runtime. */
export type AgentImpl<P, S extends Record<string, unknown>> = (
  props: P & { store: AgentStore<S> }
) => ReactNode;

export interface AgentSpec<P = any, S extends Record<string, unknown> = any> {
  /** The agent kind — becomes the class name / profile name / DO binding. */
  agentName: string;
  impl: AgentImpl<P, S>;
  initialState: S;
  /** Representative props for compile-time evaluation (resting prompt,
   *  static/dynamic analysis). Callback props should be no-ops. */
  sampleProps?: P;
  /** Imperative context-window seam. The declarative <prompt> tag (priompt
   *  priorities + token budget) wins whenever the rendered tree yields blocks;
   *  this is the fallback when it does not — a plain string derived from state.
   *  Root and child agents alike may supply it (see prompt.ts:renderPromptOrFallback). */
  getPrompt?: (state: S) => string;
}

export interface AgentBoundaryProps {
  /** Stable instance identity (host-level), e.g. `investigate:${site}`. */
  name: string;
}

/**
 * Declare an agent component. Returns a component the PARENT composes; the
 * implementation tree belongs to the child's own runtime instance.
 */
export function agentComponent<P extends Record<string, unknown>, S extends Record<string, unknown>>(
  spec: AgentSpec<P, S>
): ((props: P & AgentBoundaryProps) => ReactNode) & { spec: AgentSpec<P, S> } {
  const Boundary = (props: P & AgentBoundaryProps) => {
    const { name, ...childProps } = props;
    // The parent's tree records only the boundary — kind, identity, props.
    return <subagent name={name} kind={spec.agentName} {...childProps} />;
  };
  Boundary.spec = spec;
  Object.defineProperty(Boundary, "name", { value: spec.agentName });
  return Boundary;
}
