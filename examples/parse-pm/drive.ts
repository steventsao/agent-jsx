/**
 * The react-free driver — the worker's step loop, shared with tests.
 *
 * `runReactiveStep` (src/workflow-executor.ts) delegates subagent DESCRIPTORS,
 * which is right when children live in another runtime (chess-goal's Think
 * DOs). The parse PM's children are played IN-PROCESS through the exact
 * capabilities their boundary granted — record.handlers — the same contract a
 * SimHost world transport uses (see tests/receipt-composition.test.tsx). So
 * this driver evaluates the composition and executes ONE unit of mounted work
 * at a time, re-evaluating between units:
 *
 *   evaluate → collect records → first FRESH <task> or <subagent>
 *     task      → run(), fold via onDone
 *     subagent  → play(record) (the injected transport), fold via the record's
 *                 one result binding
 *   → evaluate again (a fold may have changed the phase and unmounted the
 *     rest) … until nothing fresh is mounted, i.e. the composition is at rest.
 *
 * Re-evaluating after EVERY unit is the honest semantics: only work that is
 * still mounted runs, exactly like SimHost's fire-time record lookup. The
 * driver never inspects budget, phases, or the doc — all policy lives in the
 * composition's own closures.
 *
 * REACT-FREE by construction: imports only the runtime file set, so the copied
 * worker package runs this module verbatim.
 */

import { collectInfra, collectPrompt, resultBindingName, type HostNode } from "../../src/tree.ts";
import { renderPrompt } from "../../src/prompt.ts";
import { createStore, withOutputs, type AgentStore, type OutputsContext } from "../../src/store.ts";
import { evaluateComponent } from "../../src/compile/evaluate.ts";
import type { InfraRecord } from "../../src/types.ts";
import { chain } from "./ports.ts";

/** What the audit trail records about each played child: exactly what crossed
 *  the boundary (serializable config) and the grant ACL — the privacy tests'
 *  grep surface. Never the handlers. */
export interface PlayedChild {
  name: string;
  kind: string;
  config: Record<string, unknown>;
  bindings: Record<string, string>;
}

export interface DriveOptions<
  P extends { store: AgentStore<S> },
  S extends Record<string, unknown>,
> {
  component: (props: P) => unknown;
  props: Omit<P, "store">;
  initialState: S;
  /** Play ONE mounted child boundary by invoking the capabilities its record
   *  grants. Resolve the child's report (fed to its result binding) or null
   *  (refused/no report — folds nothing). */
  play: (record: InfraRecord) => unknown | Promise<unknown>;
  /** Loud circuit breaker: throw once this many work units is exceeded. */
  maxUnits?: number;
  promptBudget?: number;
}

export interface DriveResult<S> {
  state: S;
  /** Audit trail of every played child, in play order. */
  played: PlayedChild[];
  /** Task names run, in run order. */
  tasks: string[];
  /** The <prompt> subtree rendered at the FINAL state. */
  prompt: string;
}

const DEFAULT_MAX_UNITS = 100;
const DEFAULT_PROMPT_BUDGET = 400;

function auditOf(record: InfraRecord): PlayedChild {
  const { kind, ...config } = record.config;
  return {
    name: record.name,
    kind: String(kind),
    config,
    bindings: Object.fromEntries(
      Object.entries(record.bindings ?? {}).map(([key, binding]) => [key, binding.kind]),
    ),
  };
}

export async function driveToRest<
  P extends { store: AgentStore<S> },
  S extends Record<string, unknown>,
>(opts: DriveOptions<P, S>): Promise<DriveResult<S>> {
  const maxUnits = opts.maxUnits ?? DEFAULT_MAX_UNITS;
  const store = createStore<S>(opts.initialState);
  const ctx: OutputsContext = {
    get outputs() {
      return (store.get() as { __outputs?: Record<string, unknown> }).__outputs ?? {};
    },
    setOutput: (name, output) => {
      store.set(
        (s) =>
          ({
            ...s,
            __outputs: {
              ...((s as { __outputs?: Record<string, unknown> }).__outputs ?? {}),
              [name]: output,
            },
          }) as S,
      );
    },
  };
  const evaluate = (): HostNode[] =>
    withOutputs(ctx, () => evaluateComponent(opts.component, { ...opts.props, store } as P));

  const played: PlayedChild[] = [];
  const tasks: string[] = [];
  const seen = new Set<string>();
  let units = 0;
  let roots: HostNode[] = [];

  for (;;) {
    // Fresh evaluate before every unit → fresh closures over current state,
    // and work unmounted by the previous fold never runs.
    roots = evaluate();
    const records: InfraRecord[] = [];
    for (const root of roots) collectInfra(root, records);

    const fresh = records.find(
      (record) =>
        (record.kind === "task" || record.kind === "subagent") &&
        !seen.has(`${record.kind}:${record.name}`),
    );
    if (!fresh) break; // composition at rest

    if (units >= maxUnits) {
      throw new Error(
        `driveToRest exceeded maxUnits=${maxUnits}: composition still mounts fresh work (${fresh.kind}:${fresh.name}).`,
      );
    }
    units += 1;
    seen.add(`${fresh.kind}:${fresh.name}`);

    if (fresh.kind === "task") {
      tasks.push(fresh.name);
      const result = await fresh.handlers.run?.();
      await fresh.handlers.onDone?.(result);
      continue;
    }

    played.push(auditOf(fresh));
    const report = await opts.play(fresh);
    const binding = resultBindingName(fresh);
    if (binding) await fresh.handlers[binding]?.(report);
  }

  return {
    state: store.get(),
    played,
    tasks,
    prompt: renderPrompt(collectPrompt(roots), opts.promptBudget ?? DEFAULT_PROMPT_BUDGET).text,
  };
}

/**
 * The region extractor's transport: play the child by invoking EXACTLY the
 * capabilities its boundary granted — pull the pre-bound slice, request the
 * metered classification, and report only on success. Synchronous when the
 * ports are synchronous (the SimHost world uses this directly); a promise in
 * the worker. It sees nothing but `record.handlers` and `record.config` — the
 * same visibility a generated child DO has through its RPC proxies.
 */
export function playRegionExtractor(record: InfraRecord): unknown | Promise<unknown> {
  return chain(record.handlers.readRegion?.(), (text) =>
    chain(record.handlers.classify?.(text), (outcome) => {
      const o = outcome as { ok?: boolean; label?: string; costUsd?: number } | undefined;
      if (!o?.ok) return null; // refused — the child has no report to file
      return {
        regionId: record.config.regionId,
        text: String(text),
        label: o.label,
        costUsd: o.costUsd,
      };
    }),
  );
}
