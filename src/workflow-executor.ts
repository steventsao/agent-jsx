/**
 * v0.5 — the reactive workflow executor (REACT-FREE runtime piece).
 *
 * flue has no state→render loop of its own: a `defineWorkflow` run() body is a
 * plain async function. This executor is the missing loop. Given a component
 * and a starting state it converges ONE turn's worth of dynamic composition:
 *
 *   round:
 *     1. evaluate the component at the current state — inside `withStaticEval`,
 *        so `useAgentState` degenerates to a store read (evaluateComponent).
 *        Handlers are re-collected EVERY round from this fresh evaluate, so a
 *        record's `onResult` closure always writes over the latest state.
 *     2. collect subagent records → FRESH = stableIds not yet delegated.
 *     3. if nothing is fresh, the composition is at rest → terminate.
 *     4. else delegate each fresh record in tree order (`session.task` in
 *        production, injected as `delegate`), then invoke THAT record's own
 *        `onResult` handler with the result — the callback prop realized. The
 *        handler mutates state through a merging store (boundStore semantics:
 *        the same get→current, set→merge contract the generated cloudflare
 *        `boundStore` implements), which feeds the next round's evaluate.
 *     5. next round.
 *
 * Past `maxRounds` with work still fresh it throws loudly rather than spinning.
 * Despawn/cancellation is deliberately OUT of scope (v1/CF semantics): a
 * completed `session.task` cannot be unspawned, so a record that stops being
 * rendered simply stops being re-delegated — it is never torn down.
 *
 * REACT-FREE by construction: it imports only the runtime file set
 * (tree/store/prompt/types + the compile/evaluate walker), never react or
 * react-reconciler. `emitRuntimeFiles` ships it as `runtime/workflow-executor.ts`
 * alongside the rest of that set.
 */

import { collectInfra, collectPrompt, resultBindingName, type HostNode } from "./tree.ts";
import { renderPrompt } from "./prompt.ts";
import { createStore, withOutputs, type AgentStore, type OutputsContext } from "./store.ts";
import { evaluateComponent } from "./compile/evaluate.ts";
import type { InfraRecord } from "./types.ts";

/**
 * A single unit of delegated work, derived from a `<subagent>` record. Mirrors
 * `spawnPlan`'s descriptor shape exactly (emit-flue.ts): `input` is the record
 * config MINUS the reserved `kind` discriminator, so a descriptor round-trips
 * byte-identically through the live SimHost path (v0.5 parity theorem).
 */
export interface SpawnDescriptor {
  /** Host-level stable identity — the mandatory `name` prop. */
  stableId: string;
  /** The subagent kind (delegation target; `session.task({ agent })`). */
  agent: string;
  /** Child input: serializable config minus the `kind` discriminator. */
  input: Record<string, unknown>;
  /** True when the boundary carries a render-prop continuation — the delegate
   *  should resolve a structured output (`{ output }`) that sets the parent's
   *  reserved slot and expands the continuation, not just a report string. */
  emits: boolean;
  /** Exact function-prop ACL generated at the JSX boundary. */
  bindings: NonNullable<InfraRecord["bindings"]>;
  /** The explicit callback that receives a plain delegated result, if any. */
  resultBinding: string | null;
  /** Live typed agent-class identity for same-process adapters. This is not
   *  serialized; cross-runtime targets continue to route by `agent`. */
  target: object | null;
}

/** What a `delegate` may resolve. Ordinary values are folded through the
 * boundary callback (`onResult`, `onTurn`, etc.); a structured `{ output }`
 * value is reserved for a render-prop continuation and routes through
 * `__emit`. Flue normally supplies text, while an interactive Worker may
 * already have parsed a provider's structured JSON response. */
export type DelegateResult = unknown;

function isStructuredOutput(r: DelegateResult): r is { output: unknown } {
  return typeof r === "object" && r !== null && "output" in r;
}

function outputsContextFor<S extends Record<string, unknown>>(store: AgentStore<S>): OutputsContext {
  return {
    get outputs() {
      return (store.get() as { __outputs?: Record<string, unknown> }).__outputs ?? {};
    },
    setOutput: (name, output) => {
      store.set(
        (s) =>
          ({
            ...s,
            __outputs: { ...((s as { __outputs?: Record<string, unknown> }).__outputs ?? {}), [name]: output },
          }) as S
      );
    },
  };
}

async function routeDelegateResult(record: InfraRecord, result: DelegateResult): Promise<void> {
  if (isStructuredOutput(result)) {
    if (record.bindings?.__emit?.kind !== "continuation") return;
    await record.handlers.__emit?.(result.output);
    return;
  }
  const resultBinding = resultBindingName(record);
  if (resultBinding) await record.handlers[resultBinding]?.(result);
}

export interface RunReactiveWorkflowOptions<
  P extends { store: AgentStore<S> },
  S extends Record<string, unknown>,
> {
  /** The agent component. Called only inside `withStaticEval` (never directly). */
  component: (props: P) => unknown;
  /** Component props minus `store` — the executor supplies the bound store. */
  props: Omit<P, "store">;
  /** State the workflow enters at (what the sensor turn produced). */
  initialState: S;
  /**
   * Delegate one fresh unit of work and resolve its result. In production this
   * is `session.task(prompt, { agent })` → response text; in tests it is a
   * deterministic stub. A plain string is fed to the record's `onResult`; a
   * structured `{ output }` is fed to the boundary's reserved `__emit` slot,
   * expanding its render-prop continuation on the next round.
   */
  delegate: (descriptor: SpawnDescriptor) => DelegateResult | Promise<DelegateResult>;
  /** Loud circuit breaker: throw once this many delegating rounds is exceeded. */
  maxRounds?: number;
  /** Token budget for the final rendered prompt (priompt-lite). Default 400. */
  promptBudget?: number;
}

export interface ReactiveWorkflowResult<S> {
  /** Final converged state. */
  state: S;
  /** Number of rounds that performed at least one delegation. */
  rounds: number;
  /** stableIds delegated, in delegation order. */
  delegated: string[];
  /** The <prompt> subtree rendered at the FINAL state, under `promptBudget`. */
  prompt: string;
}

export interface RunReactiveStepOptions<
  P extends { store: AgentStore<S> },
  S extends Record<string, unknown>,
> {
  component: (props: P) => unknown;
  props: Omit<P, "store">;
  initialState: S;
  delegate: (descriptor: SpawnDescriptor) => DelegateResult | Promise<DelegateResult>;
  promptBudget?: number;
}

export interface ReactiveStepResult<S> {
  state: S;
  descriptor: SpawnDescriptor | null;
  prompt: string;
}

const DEFAULT_MAX_ROUNDS = 100;
const DEFAULT_PROMPT_BUDGET = 400;

/** Execute at most one currently rendered subagent boundary. This is the
 * interactive counterpart to `runReactiveWorkflow`: Workers and UIs can make
 * one model move, persist state, paint, then call again for the next turn. */
export async function runReactiveStep<
  P extends { store: AgentStore<S> },
  S extends Record<string, unknown>,
>(opts: RunReactiveStepOptions<P, S>): Promise<ReactiveStepResult<S>> {
  const store = createStore<S>(opts.initialState);
  const ctx = outputsContextFor(store);
  const evaluate = (): HostNode[] =>
    withOutputs(ctx, () => evaluateComponent(opts.component, { ...opts.props, store } as P));

  const roots = evaluate();
  const records = roots.flatMap((root) => collectInfra(root));
  const record = records.find((candidate) => candidate.kind === "subagent");
  if (!record) {
    return {
      state: store.get(),
      descriptor: null,
      prompt: renderPrompt(collectPrompt(roots), opts.promptBudget ?? DEFAULT_PROMPT_BUDGET).text,
    };
  }

  const { kind, ...input } = record.config;
  const descriptor: SpawnDescriptor = {
    stableId: record.name,
    agent: String(kind),
    input,
    emits: record.bindings?.__emit?.kind === "continuation",
    bindings: record.bindings ?? {},
    resultBinding: resultBindingName(record),
    target: record.target ?? null,
  };
  await routeDelegateResult(record, await opts.delegate(descriptor));

  const finalRoots = evaluate();
  return {
    state: store.get(),
    descriptor,
    prompt: renderPrompt(
      collectPrompt(finalRoots),
      opts.promptBudget ?? DEFAULT_PROMPT_BUDGET,
    ).text,
  };
}

export async function runReactiveWorkflow<
  P extends { store: AgentStore<S> },
  S extends Record<string, unknown>,
>(opts: RunReactiveWorkflowOptions<P, S>): Promise<ReactiveWorkflowResult<S>> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const budget = opts.promptBudget ?? DEFAULT_PROMPT_BUDGET;

  // A merging store bridged to the local state — boundStore semantics: get()
  // returns the live state, set(partial|fn) merges. Handler closures written
  // during a round mutate THIS, so the next evaluate sees the new state.
  const store = createStore<S>(opts.initialState);

  // Continuation-outputs context backed by the same store's reserved __outputs
  // slot. A boundary's __emit (from a structured delegate result) writes here;
  // the next round's evaluate reads it LIVE and expands the continuation.
  const ctx = outputsContextFor(store);
  const evaluate = (): HostNode[] =>
    withOutputs(ctx, () => evaluateComponent(opts.component, { ...opts.props, store } as P));

  const delegated: string[] = [];
  const seen = new Set<string>();
  let rounds = 0;
  let roots: HostNode[] = [];

  for (;;) {
    // Fresh evaluate every round → fresh handler closures over current state.
    roots = evaluate();
    const records: InfraRecord[] = [];
    for (const root of roots) collectInfra(root, records);

    const subagents = records.filter((r) => r.kind === "subagent");
    const fresh = subagents.filter((r) => !seen.has(r.name));
    if (fresh.length === 0) break; // composition at rest — converged

    if (rounds >= maxRounds) {
      throw new Error(
        `runReactiveWorkflow exceeded maxRounds=${maxRounds}: ` +
          `composition still produced fresh delegations (${fresh
            .map((r) => r.name)
            .join(", ")}). Non-converging reactive workflow.`
      );
    }

    for (const rec of fresh) {
      const { kind, ...input } = rec.config;
      const descriptor: SpawnDescriptor = {
        stableId: rec.name,
        agent: String(kind),
        input,
        emits: rec.bindings?.__emit?.kind === "continuation",
        bindings: rec.bindings ?? {},
        resultBinding: resultBindingName(rec),
        target: rec.target ?? null,
      };
      delegated.push(rec.name);
      seen.add(rec.name);
      // `await` normalizes a sync or async delegate.
      const result = await opts.delegate(descriptor);
      // Route the result. A structured { output } sets the boundary's reserved
      // slot via __emit → the continuation expands next round (grandchild
      // descriptors). A plain string folds through the record's own onResult
      // (the callback prop realized). Both mutate state and drive the next round.
      await routeDelegateResult(rec, result);
    }
    rounds++;
  }

  const prompt = renderPrompt(collectPrompt(roots), budget).text;
  return { state: store.get(), rounds, delegated, prompt };
}
