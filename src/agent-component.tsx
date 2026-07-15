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
import { callableRefDeclaration } from "./callable.ts";

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
export type AgentRenderProps<
  P,
  S extends Record<string, unknown>,
  O = unknown,
> = P & { store: AgentStore<S>; emit?: (output: O) => void | Promise<void> };

export type AgentImpl<P, S extends Record<string, unknown>, O = unknown> = (
  props: AgentRenderProps<P, S, O>
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

type AnyFunction = (...args: any[]) => any;

/** Function-valued props are the complete cross-agent capability surface. */
export type FunctionPropKeys<P extends object> = {
  [K in keyof P]-?: [P[K]] extends [never]
    ? never
    : NonNullable<P[K]> extends AnyFunction
      ? K
      : never;
}[keyof P] & string;

/**
 * The direction/behavior of an explicitly granted function prop.
 *
 * - callback: child -> parent event; its return is ignored by convention.
 * - method: child -> parent request/response; the generated proxy returns the
 *   parent's awaited value.
 * - result: callback that also receives a delegated agent/tool result in
 *   workflow/sim runtimes. Exactly one result binding is allowed per boundary.
 */
export type AgentCapabilityKind = "callback" | "method" | "result";

export interface AgentCapabilityDeclaration<F extends AnyFunction = AnyFunction> {
  kind: AgentCapabilityKind;
  /** Optional runtime validators for RPC arguments and return values. They are
   * kept by reference in binding metadata; they are never serialized as props. */
  inputSchema?: BoundarySchema<Parameters<F>>;
  outputSchema?: BoundarySchema<Awaited<ReturnType<F>>>;
}

export type AgentCapabilities<P extends object> = {
  [K in FunctionPropKeys<P>]-?: AgentCapabilityDeclaration<Extract<NonNullable<P[K]>, AnyFunction>>;
};

/** Source profiles may use the concise `onResult: "result"` spelling. The
 * generated agentComponent always receives the normalized `{ kind }` form. */
export type AgentProfileCapabilityDeclaration<F extends AnyFunction = AnyFunction> =
  | AgentCapabilityKind
  | AgentCapabilityDeclaration<F>;

export type AgentProfileCapabilities<P extends object> = {
  [K in FunctionPropKeys<P>]-?: AgentProfileCapabilityDeclaration<
    Extract<NonNullable<P[K]>, AnyFunction>
  >;
};

type IsAny<T> = 0 extends 1 & T ? true : false;
type CapabilityRequirement<P extends object> = IsAny<P> extends true
  ? { capabilities?: Record<string, AgentCapabilityDeclaration> }
  : [FunctionPropKeys<P>] extends [never]
    ? { capabilities?: never }
    : { capabilities: AgentCapabilities<P> };

type ProfileCapabilityRequirement<P extends object> = IsAny<P> extends true
  ? { capabilities?: Record<string, AgentProfileCapabilityDeclaration> }
  : [FunctionPropKeys<P>] extends [never]
    ? { capabilities?: never }
    : { capabilities: AgentProfileCapabilities<P> };

interface AgentSpecBase<P extends object, S extends Record<string, unknown>, O> {
  /** The agent kind — becomes the class name / profile name / DO binding. */
  agentName: string;
  impl: AgentImpl<P, S, O>;
  initialState: S;
  /** Authored model identifier. Flue emits it directly; other targets retain
   * it as profile metadata and may resolve it through their model adapter. */
  model?: string;
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
  /** Opaque Agent Skills references. Class-authored agents expose these via
   * getSkills(); Flue retains the references on generated profiles. */
  skills?: readonly unknown[];
  /** Compiler-owned lowering metadata for Cloudflare-style authored classes.
   * Ordinary agentComponent specs omit these fields. */
  callableMethods?: string[];
  createBindings?: (props: P, store: AgentStore<S>) => Record<string, unknown>;
  invokeCallable?: (
    method: string,
    props: P,
    store: AgentStore<S>,
    args: unknown[],
  ) => unknown | Promise<unknown>;
}

/** Agent definition plus an exhaustive declaration for every function prop. */
export type AgentSpec<
  P extends object = any,
  S extends Record<string, unknown> = any,
  O = unknown,
> = AgentSpecBase<P, S, O> & CapabilityRequirement<P>;

/**
 * Metadata authored next to a normal JSX function component. This mirrors a
 * Flue AgentProfile: the file owns behavior and explicit authority, while the
 * compiler supplies the reusable boundary wrapper and target-specific class.
 *
 * Identity and model selection remain authored policy. The compiler does not
 * infer either from an export or filename.
 */
export type AgentProfile<
  P extends object = any,
  S extends Record<string, unknown> = any,
  O = unknown,
> = Omit<AgentSpecBase<P, S, O>, "agentName" | "impl"> &
  { name: string; model: string } &
  ProfileCapabilityRequirement<P>;

/** Type-check an authored profile without turning the implementation into a
 * boundary. `agentComponent` remains a compiler/runtime primitive. */
export function defineAgentProfile<
  P extends object,
  S extends Record<string, unknown>,
  O = unknown,
>(profile: AgentProfile<P, S, O>): AgentProfile<P, S, O> {
  return profile;
}

/** Erased spec shape used by heterogeneous compiler graphs. */
export type AnyAgentSpec = AgentSpecBase<any, any, any> & {
  capabilities?: Record<string, AgentCapabilityDeclaration>;
};

export interface AgentBoundaryProps {
  /** Stable instance identity (host-level), e.g. `investigate:${site}`. */
  name: string;
}

/** Any component returned by `agentComponent`. Useful when a composition
 * component chooses an agent class at runtime (for example a game board that
 * binds its first child to white and its second child to black). */
export type AgentClass<
  P extends object = any,
  S extends Record<string, unknown> = any,
  O = unknown,
> = ((props: P & AgentBoundaryProps & { children?: AgentContinuation<O> }) => ReactNode) & {
  spec: AgentSpec<P, S, O>;
  /** Type-only invariant marker; never read or emitted at runtime. */
  readonly __agentContract: { props: P; state: S; output: O };
};

export type AnyAgentClass = ((props: any) => ReactNode) & {
  spec: AnyAgentSpec;
  readonly __agentContract: { props: any; state: any; output: any };
};

export type AgentPropsOf<C extends AnyAgentClass> =
  C["__agentContract"]["props"];
export type AgentStateOf<C extends AnyAgentClass> =
  C["__agentContract"]["state"];
export type AgentOutputOf<C extends AnyAgentClass> =
  C["__agentContract"]["output"];

/**
 * Generic agent boundary. This is intentionally a very small adapter: a
 * higher-level composition component may inject ordinary props such as
 * `turn` and `onTurn`, while the selected agent class still owns its prompt
 * and runtime identity.
 *
 *   <Agent agentClass={OpenAIAgent} />
 *
 * The wrapper disappears during evaluation. The selected agentComponent emits
 * the real <subagent>, so existing compiler discovery and callback/RPC glue
 * continue to work without a chess-specific compiler feature.
 */
export function Agent<C extends AnyAgentClass>({
  agentClass: Selected,
  ...props
}: { agentClass: C } & AgentPropsOf<C> & AgentBoundaryProps & {
  children?: AgentContinuation<AgentOutputOf<C>>;
}): ReactNode {
  return Selected(props as AgentPropsOf<C> & AgentBoundaryProps & {
    children?: AgentContinuation<AgentOutputOf<C>>;
  });
}

type CompatibleBoundProps<BoundProps extends object, AgentProps extends object> =
  Exclude<keyof BoundProps, keyof AgentProps> extends never
    ? BoundProps extends Pick<AgentProps, keyof BoundProps & keyof AgentProps>
      ? unknown
      : never
    : never;

type BoundAgentProps<BoundProps extends object, C extends AnyAgentClass> = {
  agentClass: C & CompatibleBoundProps<BoundProps, AgentPropsOf<C>>;
} & Omit<AgentPropsOf<C>, keyof BoundProps>;

export interface AgentBinderOptions<BinderProps extends object, BoundProps extends object> {
  /** Which authored <Agent> child is active for these binder props. */
  select(props: BinderProps, childCount: number): number | null;
  /** Exact props injected into the selected class, including stable identity. */
  bind(props: BinderProps, selectedIndex: number): BoundProps & AgentBoundaryProps;
  displayName?: string;
}

/**
 * Build a higher-level typed binder such as Board. The returned, binder-scoped
 * Agent deliberately accepts only props NOT supplied by `bind`, which makes
 * `<Board><Agent agentClass={Player} /></Board>` type-safe without relying on
 * React's JSX child contextual typing (which erases generic element props).
 */
export function createAgentBinder<BinderProps extends object, BoundProps extends object>(
  options: AgentBinderOptions<BinderProps, BoundProps>
) {
  function BoundAgent<C extends AnyAgentClass>(props: BoundAgentProps<BoundProps, C>): ReactNode {
    const { agentClass: Selected, ...injected } = props as BoundAgentProps<BoundProps, AnyAgentClass> &
      Record<string, unknown>;
    return Selected(injected as unknown as Record<string, unknown> & AgentBoundaryProps);
  }

  type ElementLike = {
    type: unknown;
    props: Record<string, unknown>;
    key?: string | number | null;
  };
  const elements = (children: ReactNode): ElementLike[] => {
    const flat = Array.isArray(children) ? children.flat(Infinity) : [children];
    return flat.filter(
      (child): child is ElementLike =>
        typeof child === "object" && child !== null && "type" in child && "props" in child
    );
  };

  function Binder(props: BinderProps & { children?: ReactNode }): ReactNode {
    const { children, ...binderProps } = props;
    const agents = elements(children);
    const selectedIndex = options.select(binderProps as BinderProps, agents.length);
    if (selectedIndex === null) return null;
    const selected = agents[selectedIndex];
    if (!selected || selected.type !== BoundAgent) {
      throw new Error(
        `${options.displayName ?? "Agent binder"} needs an <Agent> child at index ${selectedIndex}`
      );
    }
    const bound = options.bind(binderProps as BinderProps, selectedIndex);
    return {
      ...selected,
      key: selected.key ?? bound.name,
      props: { ...selected.props, ...bound },
    } as ReactNode;
  }

  Object.defineProperty(BoundAgent, "name", { value: `${options.displayName ?? "Bound"}Agent` });
  Object.defineProperty(Binder, "name", { value: options.displayName ?? "AgentBinder" });
  return { Agent: BoundAgent, Binder };
}

/** A render-prop continuation on an agent boundary: pure, parent-owned, called
 *  with the child's emitted output to produce the parent's grandchildren. */
export type AgentContinuation<O> = (output: O) => ReactNode;

/**
 * A capability SLOT HANDLE — the marker a tool-slot provider's boundary passes to
 * its render-prop continuation IN PLACE OF an emitted output. Binding it to a
 * child boundary's prop registers a model-tool named after the PROP KEY, targeting
 * that child, schema'd by the child's spec (see src/compile/slots.ts + the
 * cloudflare emitter's agentTools mode). Its identity is a stable string tag (it
 * survives JSON), so a slot-handle continuation is distinguished from an
 * output-continuation by TYPE, never by guessing from syntax.
 */
export interface ToolSlotHandle {
  readonly __agentJsxToolSlot: true;
  /** agentName of the slot PROVIDER — routes the emitted getTools to that class. */
  readonly provider: string;
}
export function toolSlotHandle(provider: string): ToolSlotHandle {
  return { __agentJsxToolSlot: true, provider };
}
export function isToolSlotHandle(x: unknown): x is ToolSlotHandle {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { __agentJsxToolSlot?: unknown }).__agentJsxToolSlot === true
  );
}

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

function parseCapabilityValue(
  schema: BoundarySchema,
  value: unknown,
  phase: "arguments" | "return",
  capability: string,
  boundaryName: string,
  agentName: string
): void {
  try {
    schema.parse(value);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[agent-jsx] boundary "${boundaryName}" (kind ${agentName}): capability "${capability}" ${phase} failed schema — ${detail}`
    );
  }
}

/**
 * Compiler lowering for a normal component + AgentProfile source module.
 *
 * Application code should normally get this call from a generated companion
 * module (see compile/emit-agent-module.ts). Keeping the lowering here makes
 * the generated file tiny and preserves one boundary implementation for the
 * simulator, Cloudflare, and Flue targets.
 */
export function compileAgent<
  P extends object,
  S extends Record<string, unknown>,
  O = unknown,
>(
  impl: AgentImpl<P, S, O>,
  profile: AgentProfile<P, S, O>
): AgentClass<P, S, O> {
  const agentName = profile.name;

  const { name: _profileName, capabilities: sourceCapabilities, ...metadata } = profile as
    AgentProfile<P, S, O> & {
      capabilities?: Record<string, AgentProfileCapabilityDeclaration>;
    };
  const capabilities = sourceCapabilities
    ? Object.fromEntries(
        Object.entries(sourceCapabilities).map(([key, declaration]) => [
          key,
          typeof declaration === "string" ? { kind: declaration } : declaration,
        ])
      )
    : undefined;

  return agentComponent({
    ...metadata,
    agentName,
    impl,
    ...(capabilities ? { capabilities } : {}),
  } as unknown as AgentSpec<P, S, O>);
}

/**
 * Declare an agent component. Returns a component the PARENT composes; the
 * implementation tree belongs to the child's own runtime instance. A boundary
 * may carry function `children` — the continuation, expanded from the child's
 * emitted output (see the module header).
 */
export function agentComponent<
  P extends object,
  S extends Record<string, unknown>,
  O = unknown,
>(
  spec: AgentSpec<P, S, O>
): AgentClass<P, S, O> {
  const Boundary = (props: P & AgentBoundaryProps & { children?: AgentContinuation<O> }) => {
    const { name, children, ...childProps } = props;
    const ctx = getOutputs();
    const hasContinuation = typeof children === "function";
    const isToolSlotProvider = spec.toolSlot === true;
    // A boundary is a TOOL-SLOT BINDING when one of its props is a slot handle
    // (bound at the composition site, e.g. `<Worker onCall={handle} />`). Its
    // real input arrives from the MODEL at tool-call time, not here (COMPAT
    // investigation: agentTool validates inputSchema at the model boundary), so
    // input validation is skipped for it.
    const isToolSlotBinding = Object.values(childProps).some(isToolSlotHandle);

    // Build the explicit, non-serializable capability ACL. A function prop not
    // declared in spec.capabilities is rejected instead of becoming an implicit
    // RPC method. Declarations for optional, absent props simply grant nothing.
    const bindings: Record<string, { kind: AgentCapabilityKind | "continuation" }> = {};
    const routedChildProps = { ...childProps } as Record<string, unknown>;
    const declarations = (spec.capabilities ?? {}) as Record<string, AgentCapabilityDeclaration>;
    for (const [key, value] of Object.entries(childProps)) {
      if (typeof value !== "function") continue;
      // Class-agent render props carry a branded callable ref. The brand is the
      // explicit grant at the composition site; legacy agentComponent specs
      // continue to use their exhaustive capabilities declaration.
      const declaration = declarations[key] ?? callableRefDeclaration(value);
      if (!declaration) {
        throw new Error(
          `[agent-jsx] boundary "${name}" (kind ${spec.agentName}): function prop "${key}" has no explicit capability declaration`
        );
      }
      bindings[key] = { kind: declaration.kind };
      routedChildProps[key] = (...args: unknown[]) => {
        if (declaration.inputSchema) {
          parseCapabilityValue(
            declaration.inputSchema,
            args,
            "arguments",
            key,
            name,
            spec.agentName
          );
        }
        const returned = value(...args);
        if (returned && typeof (returned as Promise<unknown>).then === "function") {
          return Promise.resolve(returned).then((resolved) => {
            if (declaration.outputSchema) {
              parseCapabilityValue(
                declaration.outputSchema,
                resolved,
                "return",
                key,
                name,
                spec.agentName
              );
            }
            return resolved;
          });
        }
        if (declaration.outputSchema) {
          parseCapabilityValue(
            declaration.outputSchema,
            returned,
            "return",
            key,
            name,
            spec.agentName
          );
        }
        return returned;
      };
    }
    const resultBindings = Object.entries(bindings).filter(([, binding]) => binding.kind === "result");
    if (resultBindings.length > 1) {
      throw new Error(
        `[agent-jsx] boundary "${name}" (kind ${spec.agentName}): multiple result capabilities (${resultBindings
          .map(([key]) => key)
          .join(", ")})`
      );
    }

    // Validate the child's serializable INPUT against inputSchema — the props
    // that cross as `setProps`, callbacks excluded (they compile to RPC, not
    // data). A mismatch throws loudly, naming the boundary. Runs on every render
    // (sim, generated DO, discovery), so representative sampleProps must also
    // satisfy the schema — the contract holds uniformly at compile and run time.
    if (spec.inputSchema && !isToolSlotBinding) {
      const input: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(childProps)) if (typeof v !== "function") input[k] = v;
      parseAtBoundary(spec.inputSchema, input, "input", name, spec.agentName);
    }

    // Reserved output slot. A real emitted output wins; at compile time (sample
    // expansion) the boundary expands so continuation grandchildren are statically
    // discoverable — a tool-slot provider expands at a slot HANDLE (a marker,
    // never output-gated), an output-emitter at spec.sampleOutput. No output → no
    // continuation. Distinguished by TYPE (spec.toolSlot), never by syntax.
    const realOutput = ctx.outputs[name];
    const output =
      realOutput !== undefined
        ? realOutput
        : ctx.expandSamples && hasContinuation
          ? isToolSlotProvider
            ? toolSlotHandle(spec.agentName)
            : spec.sampleOutput
          : undefined;

    // Inject __emit ONLY when an OUTPUT continuation is present — its presence is
    // the signal a host uses to route a child's emitted output into the parent's
    // reserved slot (SimHost/React: on completion; CF: reserved dispatcher event;
    // workflow: a structured delegate result). A tool-slot provider emits no
    // output (its handle is a capability, not a result), so it never injects
    // __emit; and a boundary without a continuation is a no-op, so existing
    // boundaries stay byte-identical. The emit gate also VALIDATES the output
    // against outputSchema before it is written — the parent never records a
    // malformed continuation result.
    const emitProp = hasContinuation && !isToolSlotProvider
      ? {
          __emit: (o: O) => {
            if (spec.outputSchema) parseAtBoundary(spec.outputSchema, o, "output", name, spec.agentName);
            ctx.setOutput(name, o);
          },
        }
      : undefined;
    if (emitProp) bindings.__emit = { kind: "continuation" };

    return (
      <>
        {/* The parent's tree records only the boundary — kind, identity, props. */}
        <subagent
          name={name}
          kind={spec.agentName}
          {...routedChildProps}
          {...emitProp}
          __agentBindings={bindings}
          __agentTarget={Boundary}
        />
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
  Object.defineProperty(Boundary, "__agentContract", { value: null });
  return Boundary as AgentClass<P, S, O>;
}
