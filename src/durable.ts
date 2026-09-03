/**
 * The durable leaf executor — the Effect-driven engine under `<DurableRun>`.
 *
 * THE LINE THIS MODULE HOLDS. JSX supervises; it never sequences. Mounting,
 * fan-out, revocation, and regression out of `done` belong to the reactive
 * machine; retries, checkpoints, and imperative sequencing belong INSIDE a
 * durable leaf. That split only pays off if the leaf is exactly-once: a
 * re-mounted leaf must REPLAY its persisted result, never re-run its side
 * effects. This module is where that guarantee lives.
 *
 * THE AUTHORED SURFACE IS PLAIN. A workflow is a named module-level
 * `defineDurableWorkflow({ name, run })` whose `run(payload, step)` is
 * ordinary imperative TypeScript — the Cloudflare Workflows shape, so the
 * future `env.WORKFLOW.create()` lowering keeps the same authoring grammar.
 * `step.do(name, work)` is a checkpoint: a completed step's result is
 * persisted, and a later execution of the same durable run reads it back
 * instead of running `work` again. Effect never appears in these types.
 *
 * THE ENGINE INSIDE IS EFFECT. `createDurableEngine` mounts each definition
 * as an Effect Workflow whose activities are the `step.do` checkpoints, over
 * the no-sharding in-memory `WorkflowEngine`. That is the property the spike
 * (tests/effect-leaf-spike.test.ts) proved: the same durable semantics run in
 * one process with zero services, so SimHost tests observe the exactly-once
 * guarantee offline — which Cloudflare Workflows cannot offer.
 *
 * IDENTITY. An execution is addressed by (workflow name, canonical payload
 * JSON). Two mounts of the same workflow with the same payload are the SAME
 * durable execution: the second one joins or replays. A changed payload is a
 * new execution. That is what lets a phase change unmount and later remount a
 * leaf without ever running its effects twice.
 *
 * SHIPPING STATUS. The module is published as `@agent-jsx/core/durable`, but
 * its declarations expose only the plain contracts above. Effect is the one
 * pinned runtime dependency for the compiler-owned layer and workflow adapters.
 * The seam for a production driver (DO SQLite storage, or a Cloudflare
 * Workflows lowering) is the engine layer, not the authored surface.
 */

import { Cause, Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import type { DurableEngineLike, DurableWorkflowRef } from "./types.ts";

// ---------------------------------------------------------------------------
// The authored surface — plain types, no Effect

export interface DurableStepOptions {
  /** Total tries for this step within one run (default 1 — no retry). Retries
   *  happen live, inside the run; only the step's FINAL settled outcome is
   *  persisted. */
  attempts?: number;
}

/** The checkpoint API a workflow body receives. */
export interface DurableStep {
  /**
   * Run one named checkpoint. A completed step's result is persisted under
   * `name`; when the same durable execution runs again (after a crash, or a
   * remount that joins it), the persisted result is returned and `work` does
   * NOT run. Step names must be unique within one workflow run.
   *
   * FAILURE IS DURABLE. A step that exhausts its attempts fails the
   * execution, and the failure is persisted like any result: re-executing the
   * same (workflow, payload) identity REPLAYS the failure — it does not grant
   * a fresh attempt. A goal that wants to try again mounts a NEW instance:
   * same workflow, changed payload (an attempt counter is the usual shape).
   * This mirrors Cloudflare Workflows' errored-instance model, so the future
   * `env.WORKFLOW.create()` lowering keeps identical semantics.
   */
  do<T>(name: string, work: () => T | Promise<T>, options?: DurableStepOptions): Promise<T>;
}

export interface DurableWorkflowDefinition<
  In extends Record<string, unknown> = Record<string, unknown>,
  Out = unknown,
> extends DurableWorkflowRef {
  readonly name: string;
  readonly run: (payload: In, step: DurableStep) => Promise<Out>;
}

/**
 * Declare a durable workflow. Definitions are static, named, module-level
 * values — dynamic behavior comes from executing dynamic INSTANCES (payloads)
 * of a static definition, never from constructing definitions at run time.
 */
export function defineDurableWorkflow<In extends Record<string, unknown>, Out>(
  definition: DurableWorkflowDefinition<In, Out>,
): DurableWorkflowDefinition<In, Out> {
  if (!definition.name) {
    throw new Error("[durable] defineDurableWorkflow needs a non-empty `name`");
  }
  if (typeof definition.run !== "function") {
    throw new Error(`[durable] workflow "${definition.name}" needs a run(payload, step) function`);
  }
  return definition;
}

export interface DurableExecutionRequest {
  /** The workflow definition's name. */
  workflow: string;
  /** Serializable instance input. Part of the execution's durable identity. */
  payload?: Record<string, unknown>;
}

export interface DurableEngineOptions {
  /** Every workflow this engine can execute, addressed by definition name. */
  workflows: ReadonlyArray<DurableWorkflowDefinition<any, any>>;
}

/** The plain-async engine handle. Structurally satisfies `DurableEngineLike`
 *  (types.ts), which is all SimHost knows about it. */
export interface DurableEngine extends DurableEngineLike {
  execute(request: DurableExecutionRequest): Promise<unknown>;
  /** The deterministic durable identity `execute` addresses. */
  executionId(request: DurableExecutionRequest): Promise<string>;
  /** True once the execution has a persisted final result. */
  isComplete(request: DurableExecutionRequest): Promise<boolean>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Canonical identity

/**
 * Deterministic JSON: object keys sorted recursively, so two authors spelling
 * the same payload in different key order address the SAME durable execution.
 */
export function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const entry = (v as Record<string, unknown>)[k];
        if (entry !== undefined) out[k] = canonical(entry);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(canonical(value)) ?? "null";
}

// ---------------------------------------------------------------------------
// The engine

/** Results ride through the engine as `{"value":...}` JSON so `undefined`
 *  and bare primitives survive the storage schema uniformly. */
const packResult = (value: unknown): string => JSON.stringify({ value });
const unpackResult = (json: string): unknown =>
  (JSON.parse(json) as { value?: unknown }).value;

export function createDurableEngine(options: DurableEngineOptions): DurableEngine {
  const definitions = new Map<string, DurableWorkflowDefinition<any, any>>();
  for (const definition of options.workflows) {
    if (definitions.has(definition.name)) {
      throw new Error(`[durable] duplicate workflow definition "${definition.name}"`);
    }
    definitions.set(definition.name, definition);
  }

  // One Effect Workflow per definition. The payload is the canonical JSON of
  // the authored payload — which doubles as the idempotency key, so the
  // execution id is DERIVED from (workflow, payload) and nothing else. The
  // map's values are Effect Workflow handles; they stay `any` because this
  // module IS the typed/untyped boundary — the plain API above is the contract.
  const workflows = new Map<string, any>();
  const workflowLayers: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>[] = [];
  for (const definition of definitions.values()) {
    const workflow = Workflow.make(definition.name, {
      payload: { json: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ json }) => json,
    });
    workflows.set(definition.name, workflow as never);

    const workflowLayer = workflow.toLayer(
      Effect.fn(function* ({ json }) {
        // Capture the workflow fiber's live context (engine, instance, …) so
        // the plain-async `step.do` bridge can run Activities under it. The
        // authored body never sees any of this — it only sees `step`.
        const context = yield* Effect.context<any>();
        const step: DurableStep = {
          do: <T>(
            name: string,
            work: () => T | Promise<T>,
            stepOptions?: DurableStepOptions,
          ): Promise<T> => {
            const attempts = Math.max(1, stepOptions?.attempts ?? 1);
            const activity = Activity.make({
              name,
              success: Schema.String,
              error: Schema.Defect(),
              execute: Effect.tryPromise({
                try: async () => packResult(await work()),
                catch: (error) => error,
              }),
            });
            const settled =
              attempts > 1 ? Activity.retry(activity, { times: attempts - 1 }) : activity;
            return Effect.runPromiseWith(context)(
              Effect.orDie(settled) as unknown as Effect.Effect<string>,
            ).then((packed) => unpackResult(packed) as T);
          },
        };
        const payload = JSON.parse(json) as Record<string, unknown>;
        const out = yield* Effect.promise(() => definition.run(payload, step));
        return packResult(out);
      }),
    );
    workflowLayers.push(workflowLayer);
  }

  if (workflowLayers.length === 0) {
    throw new Error("[durable] createDurableEngine needs at least one workflow definition");
  }

  // The no-sharding in-memory engine. A persisted deployment swaps only this
  // layer; workflow definitions and the plain authored contract stay fixed.
  type WorkflowLayer = Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>;
  const merged = Layer.mergeAll(
    ...(workflowLayers as [WorkflowLayer, ...WorkflowLayer[]]),
  );
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(merged, WorkflowEngine.layerMemory),
  );

  const resolve = (request: DurableExecutionRequest) => {
    const workflow = workflows.get(request.workflow);
    if (!workflow) {
      throw new Error(
        `[durable] unknown workflow "${request.workflow}"; this engine knows [${[...workflows.keys()].join(", ")}]`,
      );
    }
    return { workflow, json: canonicalJson(request.payload ?? {}) };
  };

  const run = async <T>(effect: Effect.Effect<T, any, any>): Promise<T> => {
    const exit = await runtime.runPromiseExit(effect as Effect.Effect<T>);
    if (exit._tag === "Success") return exit.value;
    // Surface the authored error, not the Effect wrapper around it.
    throw Cause.squash(exit.cause);
  };

  return {
    execute: async (request) => {
      const { workflow, json } = resolve(request);
      return unpackResult(await run(workflow.execute({ json }) as Effect.Effect<string>));
    },
    executionId: async (request) => {
      const { workflow, json } = resolve(request);
      return run(workflow.executionId({ json }) as Effect.Effect<string>);
    },
    isComplete: async (request) => {
      const { workflow, json } = resolve(request);
      const id = await run(workflow.executionId({ json }) as Effect.Effect<string>);
      const polled = await run(
        workflow.poll(id) as Effect.Effect<Option.Option<{ _tag: string }>>,
      );
      return Option.isSome(polled) && polled.value._tag === "Complete";
    },
    dispose: () => runtime.dispose(),
  };
}
