/**
 * v0.6 contract — METHOD PROPS across the real DO boundary (RED).
 *
 * A function prop is not just a fire-and-forget event: it is a capability
 * with a RETURN VALUE. The child awaits `props.lookupRunbook(site)` like a
 * local function; the generated bindings must round-trip it:
 *
 *   child proxy → parent.onAgentEvent({callback}) → parent's FRESHEST
 *   closure computes from parent state → return value crosses back over
 *   RPC → the child's awaiting code continues with it.
 *
 * RED because today the dispatcher returns void and proxies don't await a
 * result — the finding would contain "runbook: undefined".
 *
 * May not be weakened: the finding must contain BOTH the runbook text and
 * the parent-state-derived suffix ("statuses tracked: 1"), proving the
 * value was computed by the parent's live closure, not child-local data.
 */

import { env, runInDurableObject as runInDurableObjectRaw } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

type AnyAgent = {
  state: Record<string, any>;
  setState(s: Record<string, any>): void;
  onAgentEvent(p: { key: string; args?: unknown[] }): Promise<unknown>;
  reconcile?(): Promise<void>;
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
const CHILD_NAME = `mp-main:investigate:${DOWN_SITE}`;

describe("method props: request/response RPC with return values", () => {
  it("child awaits a parent capability and folds its return value back", async () => {
    const parent = (await getAgentByName(env.UPTIME as never, "mp-main")) as never as DurableObjectStub;
    await runInDurableObject(parent, async (agent: AnyAgent) => {
      agent.setState({
        statuses: { [DOWN_SITE]: { state: "down", since: 4 } },
        findings: {},
      });
      await new Promise((r) => setTimeout(r, 50)); // onStateChanged reconcile
    });

    // getAgentByName routes by name only — namespace instances are global, so
    // the child spawned by "mp-main" is addressable the same way.
    const child = (await getAgentByName(env.INVESTIGATOR as never, CHILD_NAME)) as never as DurableObjectStub;
    await runInDurableObject(child, async (c: AnyAgent) => {
      await c.onAgentEvent({ key: "schedule:sla-deadline" });
    });

    const findings = await runInDurableObject(
      parent,
      (agent: AnyAgent) => agent.state.findings as Record<string, string>
    );
    const finding = String(findings[DOWN_SITE]);
    expect(finding).toContain("restart edge pods for " + DOWN_SITE);
    expect(finding).toContain("statuses tracked: 1"); // computed by the PARENT's closure
    expect(finding).not.toContain("undefined");
  });
});
