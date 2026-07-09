/**
 * THE continuation compat proof: the generated classes run the full
 * function-as-children round-trip on the REAL cloudflare/agents package inside
 * real workerd (vitest-pool-workers — headless, no dev server, no mocks).
 *
 * Behavior under test (the continuation contract, end to end across THREE DOs):
 *   1. the parent spawns the emitter (its standing static subagent) with props
 *   2. the emitter's <task> runs IN ITS OWN DO and `emit`s the split items
 *   3. that emit compiles to a reserved `__emit` callback RPC that lands the
 *      items in the PARENT's durable `__outputs` slot (not the emitter's)
 *   4. the parent re-renders → its render-prop continuation fans out one folder
 *      grandchild per item — the parent's OWN direct children
 *   5. each folder runs its own <task> in its own DO: its result is visible in
 *      the folder's OWN state AND folds back into parent state via `onFolded`
 *
 * These assertions define the contract. Fix the EMITTERS (or this package's
 * plumbing) to satisfy them; do not weaken the assertions. API-shape details
 * (runInDurableObject signatures, stub typing) may be adjusted freely.
 *
 * Alarms do not auto-fire under vitest-pool-workers, so — exactly like
 * uptime.spec — each DO's pending work is driven with an explicit reconcile()
 * (deployed, the child's post-adoption `schedule(0, …)` wake tick drives it).
 */

import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

type AnyAgent = {
  state: Record<string, any>;
  applyState(update: Record<string, any>): Promise<void>;
  reconcile?(): Promise<void>;
};

declare module "cloudflare:test" {
  interface ProvidedEnv {
    CONT_ROOT: DurableObjectNamespace;
    CONT_EMITTER: DurableObjectNamespace;
    CONT_FOLDER: DurableObjectNamespace;
  }
}

const PARENT = "cont-main";
// Child instance names are `${parentName}:${boundaryName}` — the reconcile's
// self-scoped identity (uptime.spec.ts uses the same shape).
const EMITTER = `${PARENT}:emit:main`;
const FOLDER = (item: string) => `${PARENT}:fold:${item}`;

// Reach DOs via getAgentByName — the production path — so partyserver's
// request-scoped `this.name` is set before any setState/_emit (uptime.spec.ts,
// COMPAT-REPORT #1).
const parentStub = async () =>
  (await getAgentByName(env.CONT_ROOT as never, PARENT)) as never as DurableObjectStub;
const emitterStub = async () =>
  (await getAgentByName(env.CONT_EMITTER as never, EMITTER)) as never as DurableObjectStub;
const folderStub = async (item: string) =>
  (await getAgentByName(env.CONT_FOLDER as never, FOLDER(item))) as never as DurableObjectStub;

describe("continuation nesting on real cloudflare/agents", () => {
  it("runs emit → reserved __emit RPC → parent __outputs → grandchild fan-out end to end", async () => {
    // 1. Push a seed. applyState merges + reconciles → the emitter (static
    //    subagent) is spawned with props { seed }.
    await runInDurableObject(await parentStub(), async (agent: AnyAgent) => {
      await agent.applyState({ seed: "a,b" });
    });
    const emitterProps = await runInDurableObject(
      await emitterStub(),
      (e: AnyAgent) => e.state.__props
    );
    expect(emitterProps).toMatchObject({ seed: "a,b" });

    // 2 + 3. Drive the emitter: its <task> runs in ITS DO, splits the seed, and
    //    `emit`s. That emit is a reserved `__emit` callback RPC back to the
    //    parent, which writes the items into the PARENT's durable __outputs.
    await runInDurableObject(await emitterStub(), async (e: AnyAgent) => {
      await e.reconcile?.();
    });

    const outputs = await runInDurableObject(
      await parentStub(),
      (agent: AnyAgent) => agent.state.__outputs as Record<string, unknown>
    );
    expect(outputs["emit:main"]).toEqual(["a", "b"]); // reserved __emit → durable __outputs

    // 4. The emit landed __outputs synchronously, but the continuation fan-out
    //    runs in the concurrent onStateChanged reconcile that __emit REQUESTS
    //    (mark-and-return, not awaited — the await-cycle guard, COMPAT-REPORT #35).
    //    Drive one drained reconcile to converge it deterministically — exactly
    //    the explicit-reconcile pattern uptime.spec uses because vitest alarms
    //    do not auto-fire (deployed, the emitter's post-emit wake tick drives it).
    await runInDurableObject(await parentStub(), async (agent: AnyAgent) => {
      await agent.reconcile?.();
    });

    // The parent re-rendered on that output and fanned out one folder grandchild
    // per item — the parent's OWN direct children.
    const children = await runInDurableObject(
      await parentStub(),
      (agent: AnyAgent) => agent.state.__children as { name: string; kind: string }[]
    );
    const childNames = children.map((c) => c.name).sort();
    expect(childNames).toEqual([EMITTER, FOLDER("a"), FOLDER("b")].sort());
    // the grandchildren are the cont-folder kind, spawned under the parent
    expect(children.filter((c) => c.kind === "cont-folder").map((c) => c.name).sort()).toEqual(
      [FOLDER("a"), FOLDER("b")].sort()
    );

    // The grandchildren were adopted with their per-item props.
    const folderAProps = await runInDurableObject(
      await folderStub("a"),
      (f: AnyAgent) => f.state.__props
    );
    expect(folderAProps).toMatchObject({ item: "a" });

    // 5. Drive each folder: its <task> upper-cases the item in ITS OWN DO
    //    (state visible there) and folds the result back into the parent.
    for (const item of ["a", "b"]) {
      await runInDurableObject(await folderStub(item), async (f: AnyAgent) => {
        await f.reconcile?.();
      });
    }

    // grandchild state is visible in the grandchild's OWN DO
    expect(await runInDurableObject(await folderStub("a"), (f: AnyAgent) => f.state.folded)).toBe(
      "A"
    );
    expect(await runInDurableObject(await folderStub("b"), (f: AnyAgent) => f.state.folded)).toBe(
      "B"
    );

    // …and it folded back into the parent through the onFolded callback.
    const folded = await runInDurableObject(
      await parentStub(),
      (agent: AnyAgent) => agent.state.folded as Record<string, string>
    );
    expect(folded).toEqual({ a: "A", b: "B" });
  });
});
