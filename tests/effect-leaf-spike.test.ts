/**
 * SPIKE — the durable LEAF executor the goal layer will eventually mount.
 *
 * Deliberately isolated: this file imports NOTHING from src/. It is a load-
 * bearing question about a third-party runtime, answered against the real
 * published packages rather than a mock, and the answer is what a future
 * `<DurableRun workflowClass={…} onResult={result(send)} />` would rest on.
 *
 * THE QUESTION. The goal layer draws a hard line: JSX supervises, it never
 * sequences. Mounting, fan-out, revocation, human events, and regression out of
 * `done` belong to the reactive machine; retries, checkpoints, and durable
 * sleep belong INSIDE an imperative leaf. That split only pays off if the leaf
 * really is exactly-once — if a re-run replayed its side effects, the machine
 * would have to defend against duplicates and the boundary would be a lie.
 *
 * THE ANSWER (Effect 3.22 / @effect/workflow 0.19 / @effect/cluster 0.60):
 * yes, and without SQL or shard infrastructure. `TestRunner.layer` is an
 * entirely in-memory cluster, so `ClusterWorkflowEngine` runs the same durable
 * semantics in a unit test that it would run over DO SQLite. A workflow's
 * `idempotencyKey` derives its execution id; a second execution under that id
 * REPLAYS — completed activity results are read back, not recomputed.
 *
 * WHY THIS MATTERS FOR SimHost. Cloudflare Workflows cannot do this: there is
 * no in-process engine, so durable-leaf semantics are only observable after a
 * deploy. An in-memory engine puts the leaf's exactly-once guarantee under the
 * same deterministic, offline test loop the rest of the composition already
 * runs under.
 *
 * NOT YET SETTLED (out of scope here, recorded so it is not mistaken for done):
 * `@effect/cluster`'s sharding is heavy for a single Durable Object — the
 * wanted shape is a WorkflowEngine over local MessageStorage with no sharding.
 * And Effect must never reach the authored surface: props and callbacks stay
 * plain async/JSX, with Effect confined to the leaf's implementation.
 */

import { describe, expect, it } from "bun:test";
import { ClusterWorkflowEngine, TestRunner } from "@effect/cluster";
import { Activity, Workflow } from "@effect/workflow";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

/** One durable leaf: "upgrade this package", with a single side-effecting step. */
function makeUpgradeLeaf() {
  /** Every real execution of the activity body appends here. Nothing else does. */
  const sideEffects: string[] = [];

  const UpgradeDeps = Workflow.make({
    name: "UpgradeDeps",
    payload: { pkg: Schema.String },
    success: Schema.String,
    // The execution id is DERIVED from the payload. Two runs of the same
    // upgrade are the same execution — which is what makes a re-run a replay
    // rather than a second attempt.
    idempotencyKey: (payload) => `upgrade:${payload.pkg}`,
  });

  const workflowLayer = UpgradeDeps.toLayer(
    Effect.fn(function* (payload) {
      return yield* Activity.make({
        name: "bump-lockfile",
        success: Schema.String,
        execute: Effect.sync(() => {
          sideEffects.push(payload.pkg);
          // The attempt number is baked into the result, so a replayed result
          // is distinguishable from a recomputed one by VALUE, not just by
          // counting calls.
          return `bumped ${payload.pkg} (attempt ${sideEffects.length})`;
        }),
      });
    }),
  );

  const runtime = ManagedRuntime.make(
    workflowLayer.pipe(
      Layer.provideMerge(
        ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(TestRunner.layer)),
      ),
    ),
  );

  return { UpgradeDeps, runtime, sideEffects };
}

describe("effect durable leaf — exactly-once across a replay", () => {
  it("runs the activity body ONCE and replays the persisted result", async () => {
    const { UpgradeDeps, runtime, sideEffects } = makeUpgradeLeaf();
    try {
      const executionId = await runtime.runPromise(UpgradeDeps.executionId({ pkg: "react" }));

      // Run 1: the body executes.
      const first = await runtime.runPromise(UpgradeDeps.execute({ pkg: "react" }));
      expect(first).toBe("bumped react (attempt 1)");
      expect(sideEffects).toEqual(["react"]);

      // Run 2, same payload, same durable storage: a REPLAY. The body must not
      // run again, and the caller must get the persisted result back verbatim.
      const second = await runtime.runPromise(UpgradeDeps.execute({ pkg: "react" }));
      expect(second).toBe("bumped react (attempt 1)");
      expect(sideEffects).toEqual(["react"]);

      // And the result is genuinely persisted, not just memoized in a closure.
      const polled = await runtime.runPromise(UpgradeDeps.poll(executionId));
      expect(polled?._tag).toBe("Complete");
    } finally {
      await runtime.dispose();
    }
  });

  it("the oracle bites: a different payload is a different execution and DOES run", async () => {
    // Without this, "the counter stayed at 1" would be equally explained by an
    // engine that silently never ran anything after the first call.
    const { UpgradeDeps, runtime, sideEffects } = makeUpgradeLeaf();
    try {
      await runtime.runPromise(UpgradeDeps.execute({ pkg: "react" }));
      const other = await runtime.runPromise(UpgradeDeps.execute({ pkg: "vite" }));

      expect(other).toBe("bumped vite (attempt 2)");
      expect(sideEffects).toEqual(["react", "vite"]);

      const reactId = await runtime.runPromise(UpgradeDeps.executionId({ pkg: "react" }));
      const viteId = await runtime.runPromise(UpgradeDeps.executionId({ pkg: "vite" }));
      expect(reactId).not.toBe(viteId);
    } finally {
      await runtime.dispose();
    }
  });

  it("derives a deterministic execution id from the payload", async () => {
    // The idempotency key is the whole contract: a leaf mounted, unmounted, and
    // re-mounted by a phase change must address the SAME durable execution.
    const first = makeUpgradeLeaf();
    const second = makeUpgradeLeaf();
    try {
      expect(await first.runtime.runPromise(first.UpgradeDeps.executionId({ pkg: "react" }))).toBe(
        await second.runtime.runPromise(second.UpgradeDeps.executionId({ pkg: "react" })),
      );
    } finally {
      await first.runtime.dispose();
      await second.runtime.dispose();
    }
  });
});
