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
 * CONTINUATION NESTING — function-as-children on a boundary:
 *
 *   <LayoutReviewer name="review:main" page={page}>
 *     {(boxes) => boxes.map((b) => <BboxExtractor name={`bbox:${b.id}`} bbox={b} … />)}
 *   </LayoutReviewer>
 *
 *   The child PRODUCES output via an injected `emit(output)` capability (like
 *   `store`). `emit` routes like any callback, but into a RESERVED slot: the
 *   parent runtime writes `__outputs[<name>] = output` into parent state and
 *   re-renders. The continuation `(output) => ReactNode` is pure and
 *   PARENT-owned: at parent render time, once the output exists it is called
 *   and its records merge into the parent's desired set — the grandchildren are
 *   the parent's DIRECT children (parent spawns them, parent env binds them).
 *   Closures never serialize; the continuation re-renders from persisted state.
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
import { getOutputs } from "./store.ts";

/** What a child agent's implementation receives at runtime. `emit` is the
 *  continuation output channel — call it when the result is ready (e.g. in a
 *  <task> onDone). It routes like a callback into the parent's reserved output
 *  slot, driving the parent's render-prop continuation. Optional in the type
 *  (a root emits to no one, and direct root-render sites omit it) but ALWAYS
 *  provided by a runtime; an emitting child `await`s `emit?.(output)`.
 *
 *  It resolves `void | Promise<void>`: inert in the sim/React path (a synchronous
 *  store write), but on Cloudflare it is a cross-DO callback RPC that drives the
 *  PARENT's reconcile (its continuation grandchildren spawn before it resolves).
 *  So an emitting `<task>` MUST `await` it — an un-awaited emit leaves the RPC
 *  pending when the child's reconcile resolves and workerd tears the I/O context
 *  down mid-flight ("Closing rpc while resolve was pending"), exactly the
 *  await-the-cross-DO-call rule the dispatcher already honors (COMPAT-REPORT #22, #37). */
export type AgentImpl<P, S extends Record<string, unknown>, O = unknown> = (
  props: P & { store: AgentStore<S>; emit?: (output: O) => void | Promise<void> }
) => ReactNode;

/** The minimal schema shape a boundary validates against: a `parse` that
 *  returns the value or THROWS on mismatch. zod's `ZodType` satisfies this
 *  structurally, so a caller passes `z.object({...})` directly — but the runtime
 *  file set imports no zod (artifacts stay self-contained); validation is duck-
 *  typed on `.parse`. Any Standard-Schema-ish validator with a throwing `parse`
 *  works. */
export interface BoundarySchema<T = unknown> {
  parse(value: unknown): T;
}

export interface AgentSpec<P = any, S extends Record<string, unknown> = any, O = unknown> {
  /** The agent kind — becomes the class name / profile name / DO binding. */
  agentName: string;
  impl: AgentImpl<P, S, O>;
  initialState: S;
  /** Human-readable one-liner. Embedded in generated artifacts (the cloudflare
   *  class doc, the flue profile `description`) and, when this agent fills a tool
   *  slot, surfaced as the `agentTool` description — so the contract is visible
   *  in fixtures, not just enforced. */
  description?: string;
  /** Display label for tool/agent registries (e.g. `agentTool` displayName). */
  displayName?: string;
  /** Validates the child's serializable INPUT — the boundary's non-callback
   *  props, i.e. exactly what crosses as `setProps`. A mismatch THROWS loudly,
   *  naming the boundary. zod-compatible; the runtime imports no zod. */
  inputSchema?: BoundarySchema;
  /** Validates a continuation OUTPUT before it is written to the parent's
   *  reserved `__outputs` slot. A mismatch THROWS loudly, naming the boundary. */
  outputSchema?: BoundarySchema<O>;
  /** Marks this agent as a TOOL-SLOT provider: a boundary carrying a function
   *  child receives a capability slot HANDLE (a marker), not an emitted output.
   *  Binding that handle to a child boundary's prop registers a model-tool named
   *  after the prop key, targeting that child, schema'd by the child's spec.
   *  See src/slot.ts + the cloudflare emitter's agentTools mode. */
  toolSlot?: boolean;
  /** Representative props for compile-time evaluation (resting prompt,
   *  static/dynamic analysis). Callback props should be no-ops. */
  sampleProps?: P;
  /** Representative emitted output for compile-time continuation expansion:
   *  discovery/analysis expand a boundary's render-prop `children` at this
   *  value when no real output has landed, so grandchildren produced ONLY via
   *  the continuation are still discovered (their agent KINDS drive class/
   *  binding/profile generation). Continuation-produced boundaries are DYNAMIC
   *  by definition — output-gated, never present at rest. */
  sampleOutput?: O;
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

/** A render-prop continuation on an agent boundary: pure, parent-owned, called
 *  with the child's emitted output to produce the parent's grandchildren. */
export type AgentContinuation<O> = (output: O) => ReactNode;

/** Validate a value at a boundary, throwing LOUDLY with the boundary's identity
 *  when it does not match. Wraps whatever the schema's `parse` throws (zod's
 *  ZodError message, a custom validator's error, …) with the boundary name +
 *  kind, so a violation points straight at the offending composition site. */
function parseAtBoundary(
  schema: BoundarySchema,
  value: unknown,
  kind: "input" | "output",
  boundaryName: string,
  agentName: string
): void {
  try {
    schema.parse(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[agent-jsx] boundary "${boundaryName}" (kind ${agentName}): ${kind} does not match ${kind}Schema — ${detail}`
    );
  }
}

/**
 * Declare an agent component. Returns a component the PARENT composes; the
 * implementation tree belongs to the child's own runtime instance. A boundary
 * may carry function `children` — the continuation, expanded from the child's
 * emitted output (see the module header).
 */
export function agentComponent<
  P extends Record<string, unknown>,
  S extends Record<string, unknown>,
  O = unknown,
>(
  spec: AgentSpec<P, S, O>
): ((props: P & AgentBoundaryProps & { children?: AgentContinuation<O> }) => ReactNode) & {
  spec: AgentSpec<P, S, O>;
} {
  const Boundary = (props: P & AgentBoundaryProps & { children?: AgentContinuation<O> }) => {
    const { name, children, ...childProps } = props;
    const ctx = getOutputs();
    const hasContinuation = typeof children === "function";

    // Validate the child's serializable INPUT against inputSchema — the props
    // that cross as `setProps`, callbacks excluded (they compile to RPC, not
    // data). A mismatch throws loudly, naming the boundary. Runs on every render
    // (sim, generated DO, discovery), so representative sampleProps must also
    // satisfy the schema — the contract holds uniformly at compile and run time.
    if (spec.inputSchema) {
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(childProps)) if (typeof v !== "function") input[k] = v;
      parseAtBoundary(spec.inputSchema, input, "input", name, spec.agentName);
    }

    // Reserved output slot. A real emitted output wins; at compile time (sample
    // expansion) the boundary expands at spec.sampleOutput so continuation
    // grandchildren are statically discoverable. No output → no continuation.
    const realOutput = ctx.outputs[name];
    const output =
      realOutput !== undefined
        ? realOutput
        : ctx.expandSamples && hasContinuation
          ? spec.sampleOutput
          : undefined;

    // Inject __emit ONLY when a continuation is present — its presence is the
    // signal a host uses to route a child's emitted output into the parent's
    // reserved slot (SimHost/React: on completion; CF: reserved dispatcher
    // event; workflow: a structured delegate result). Without a continuation a
    // child's emit is a no-op, so we do not inject and existing boundaries are
    // byte-identical. The emit gate also VALIDATES the output against
    // outputSchema before it is written — the parent never records a malformed
    // continuation result.
    const emitProp = hasContinuation
      ? {
          __emit: (o: O) => {
            if (spec.outputSchema) parseAtBoundary(spec.outputSchema, o, "output", name, spec.agentName);
            ctx.setOutput(name, o);
          },
        }
      : undefined;

    return (
      <>
        {/* The parent's tree records only the boundary — kind, identity, props. */}
        <subagent name={name} kind={spec.agentName} {...childProps} {...emitProp} />
        {/* Grandchildren: the continuation, expanded once the child has emitted.
            They are the PARENT's direct children — parent spawns and binds them. */}
        {hasContinuation && output !== undefined
          ? (children as AgentContinuation<O>)(output as O)
          : null}
      </>
    );
  };
  Boundary.spec = spec;
  Object.defineProperty(Boundary, "name", { value: spec.agentName });
  return Boundary;
}
