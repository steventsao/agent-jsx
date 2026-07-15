/**
 * THE compat proof: the generated classes run on the real cloudflare/agents
 * package inside real workerd (vitest-pool-workers — headless, no dev server).
 *
 * Behavior under test (the composition contract, end to end):
 *   1. state change on the parent → child DO spawned with serializable props
 *   2. parent re-render with changed props → child receives updated props
 *   3. child invokes a callback prop → RPC routes to the parent's dispatcher
 *      → freshest closure runs → parent state updates
 *   4. recovery → child despawned (shutdown), schedules converge, no dupes
 *   5. onStart is idempotent: repeated wakes never duplicate schedules
 *
 * These assertions define the contract. Fix the EMITTERS (or this package's
 * plumbing) to satisfy them; do not weaken the assertions. API-shape details
 * (runInDurableObject signatures, stub typing) may be adjusted freely.
 */

import { env, runInDurableObject as runInDurableObjectRaw } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

type AnyAgent = {
  state: Record<string, any>;
  setState(s: Record<string, any>): void;
  getSchedules(): Promise<{ id: string; payload: unknown }[]>;
  onAgentEvent(p: { key: string; args?: unknown[] }): Promise<void>;
  reconcile?(): Promise<void>;
  onStart(): Promise<void>;
};

declare module "cloudflare:test" {
  interface ProvidedEnv {
    UPTIME: DurableObjectNamespace;
    INVESTIGATOR: DurableObjectNamespace;
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      UPTIME: DurableObjectNamespace;
      INVESTIGATOR: DurableObjectNamespace;
    }
  }
}

const runInDurableObject = <T>(
  stub: DurableObjectStub,
  callback: (agent: AnyAgent) => T | Promise<T>,
) => runInDurableObjectRaw(stub, (instance) => callback(instance as unknown as AnyAgent));

const DOWN_SITE = "https://b.example";
const CHILD_NAME = `main:investigate:${DOWN_SITE}`;

// Reach DOs via getAgentByName — the production path — NOT raw
// env.NS.get(idFromName(...)): the agents pkg reads `this.name` inside
// _emit/setState, and partyserver's name is only set by getAgentByName /
// setName on the stub (partyserver src/index.ts:601, workerd issue #2240).
const parentStub = async () => (await getAgentByName(env.UPTIME as never, "main")) as never as DurableObjectStub;
const childStub = async () => (await getAgentByName(env.INVESTIGATOR as never, CHILD_NAME)) as never as DurableObjectStub;

const incident = (since: number) => ({
  statuses: { [DOWN_SITE]: { state: "down", since } },
  findings: {},
});

describe("generated classes on real cloudflare/agents", () => {
  it("boots the parent and converges initial schedules idempotently", async () => {
    await runInDurableObject(await parentStub(), async (agent: AnyAgent) => {
      // onStart DEFERS reconcile to a __wake-reconcile alarm — reconciling
      // inside onStart's blockConcurrencyWhile deadlocks (COMPAT-REPORT #34).
      // reconcile() awaits full drain (the alarm path only marks-and-returns),
      // so it deterministically observes convergence + idempotency here; it is
      // exactly what the deployed alarm tick eventually drives.
      await agent.onStart();
      await agent.reconcile?.();
      const first = await agent.getSchedules();
      await agent.onStart(); // wake again — must not duplicate
      await agent.reconcile?.();
      const second = await agent.getSchedules();
      expect(second.length).toBe(first.length);
      // 3 sensors + 1 report schedule from the component tree
      expect(first.length).toBe(4);
    });
  });

  it("spawns the child with props when state says a site is down", async () => {
    // No explicit reconcile: this asserts the production path —
    // setState → onStateChanged (agents 0.8.5; onStateUpdate is deprecated,
    // packages/agents/src/index.ts:685-1121) → reconcile.
    await runInDurableObject(await parentStub(), async (agent: AnyAgent) => {
      agent.setState(incident(4));
      await new Promise((r) => setTimeout(r, 50)); // let the hook's async reconcile settle
    });
    const props = await runInDurableObject(await childStub(), (child: AnyAgent) => child.state.__props);
    expect(props).toMatchObject({ site: DOWN_SITE, since: 4 });
  });

  it("pushes prop CHANGES across the boundary on parent re-render", async () => {
    await runInDurableObject(await parentStub(), async (agent: AnyAgent) => {
      agent.setState(incident(9));
      await agent.reconcile?.();
    });
    const props = await runInDurableObject(await childStub(), (child: AnyAgent) => child.state.__props);
    expect(props).toMatchObject({ since: 9 });
  });

  it("routes a child callback to the parent's freshest closure", async () => {
    // The child's sla-deadline schedule calls onResult — fire it directly.
    await runInDurableObject(await childStub(), async (child: AnyAgent) => {
      await child.onAgentEvent({ key: "schedule:sla-deadline" });
    });
    const findings = await runInDurableObject(
      await parentStub(),
      (agent: AnyAgent) => agent.state.findings
    );
    expect(Object.keys(findings)).toContain(DOWN_SITE);
    expect(String(findings[DOWN_SITE])).toContain(DOWN_SITE);
  });

  it("despawns the child when the site recovers", async () => {
    await runInDurableObject(await parentStub(), async (agent: AnyAgent) => {
      // Merge, don't replace: raw setState full-replacement would wipe the
      // runtime's __children bookkeeping (production writes flow through the
      // merging boundStore). Divergence noted in COMPAT-REPORT.md — reserved
      // keys in user state are fragile; agents hides its own _cf_ keys.
      agent.setState({
        ...agent.state,
        statuses: { [DOWN_SITE]: { state: "up", since: 11 } },
      });
      await agent.reconcile?.();
      expect((agent.state as { __children?: unknown[] }).__children).toEqual([]);
    });
    await runInDurableObject(await childStub(), async (child: AnyAgent) => {
      expect(child.state.__props).toBeNull();
      expect((await child.getSchedules()).length).toBe(0);
    });
  });
});
