/**
 * React-free agent state store.
 *
 * This is the half of the old `state.ts` that a compiled artifact needs and
 * that must never import react: the external store, the static-eval flag, and
 * a `useAgentState` that degenerates to a plain read (compiled targets always
 * re-render explicitly over persisted state — there is nothing to subscribe
 * to, and no React dispatcher on the stack to call a real hook against).
 *
 * `state.ts` re-exports `createStore`/`withStaticEval`/`AgentStore` from here
 * and layers the react `useAgentState` (useSyncExternalStore) on top for the
 * dev/React path.
 */

export interface AgentStore<S> {
  get(): S;
  set(update: Partial<S> | ((prev: S) => S)): void;
  subscribe(listener: () => void): () => void;
  snapshot(): string;
}

export function createStore<S extends Record<string, unknown>>(initial: S): AgentStore<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (update) => {
      state =
        typeof update === "function" ? (update as (prev: S) => S)(state) : { ...state, ...update };
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => JSON.stringify(state),
  };
}

/**
 * Compiled targets evaluate components WITHOUT React: the runtime re-renders
 * explicitly on every setState, so there is nothing to subscribe to.
 *
 * Package entrypoints are bundled independently, so a module-local flag would
 * give each entrypoint its own static-eval state. Keep a depth counter on the
 * realm global instead: Symbol.for gives every bundled copy the same key, and
 * a depth (rather than a boolean) preserves an outer evaluation across nested
 * compiler/evaluator calls.
 */
const STATIC_EVAL_DEPTH = Symbol.for("@agent-jsx/core/static-eval-depth");
type StaticEvalGlobal = typeof globalThis & Record<symbol, unknown>;

function getStaticEvalDepth(): number {
  const depth = (globalThis as StaticEvalGlobal)[STATIC_EVAL_DEPTH];
  return typeof depth === "number" && Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
}

export function withStaticEval<R>(fn: () => R): R {
  const shared = globalThis as StaticEvalGlobal;
  const previousDepth = getStaticEvalDepth();
  shared[STATIC_EVAL_DEPTH] = previousDepth + 1;
  try {
    return fn();
  } finally {
    if (previousDepth === 0) delete shared[STATIC_EVAL_DEPTH];
    else shared[STATIC_EVAL_DEPTH] = previousDepth;
  }
}
export function isStaticEval(): boolean {
  return getStaticEvalDepth() > 0;
}

/**
 * Render-scoped CONTINUATION-OUTPUTS context — the react-free counterpart of
 * `withStaticEval`, so an agent boundary's render-prop continuation expands
 * without threading props.
 *
 * An agent boundary that carries function children (`{(output) => …}`) needs
 * two things at render time: the child's most-recent emitted output (to expand
 * the continuation) and a way to record a new one (to inject the child's `emit`
 * channel). Every runtime sets this context before it evaluates — the React
 * commit path, the compile/evaluate walker, the generated FiberAgentBase, the
 * reactive workflow executor — so the wrapper reads it uniformly and every host
 * delivers outputs the same way.
 */
export interface OutputsContext {
  /** boundaryName → the child's most-recent emitted output (the reserved slot). */
  outputs: Record<string, unknown>;
  /** Record a boundary's output: merge into parent state, then re-render. */
  setOutput: (boundaryName: string, output: unknown) => void;
  /** Compile-time discovery/analysis expands a boundary's continuation at its
   *  `spec.sampleOutput` when no real output has landed, so grandchildren
   *  produced ONLY via a continuation are still statically discoverable. */
  expandSamples?: boolean;
}

const DEFAULT_OUTPUTS: OutputsContext = { outputs: {}, setOutput: () => {}, expandSamples: false };
let currentOutputs: OutputsContext = DEFAULT_OUTPUTS;

/** Establish the outputs context for the duration of `fn` (nestable). */
export function withOutputs<R>(ctx: OutputsContext, fn: () => R): R {
  const prev = currentOutputs;
  currentOutputs = ctx;
  try {
    return fn();
  } finally {
    currentOutputs = prev;
  }
}

/** Read the active outputs context; a bare evaluate (no context) gets an inert
 *  default: no outputs, a no-op setter, no sample expansion. */
export function getOutputs(): OutputsContext {
  return currentOutputs;
}

/**
 * React-free `useAgentState`: a plain read of the store. Compiled artifacts
 * import THIS (not the react one in `state.ts`) — they evaluate components by
 * direct call, off the React stack, so a real hook would throw "invalid hook
 * call". Correct because the compiled runtime re-renders on every setState.
 */
export function useAgentState<S extends Record<string, unknown>>(store: AgentStore<S>): S {
  return store.get();
}
