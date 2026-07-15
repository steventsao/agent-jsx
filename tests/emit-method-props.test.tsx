/**
 * v0.6 emitter contract — method-prop bindings (RED).
 *
 * The generated child proxies must RETURN the parent dispatcher's result
 * (request/response), not fire-and-forget; the dispatcher must return the
 * invoked closure's (awaited) result so the value crosses the RPC boundary.
 * compat/cloudflare/test/method-props.spec.ts proves the behavior in real
 * workerd; this locks the emitted wiring.
 */

import { describe, expect, it } from "bun:test";
import { buildFixtures } from "../scripts/gen-fixtures.tsx";

describe("emitted method-prop bindings", () => {
  const cf = buildFixtures()["uptime.cloudflare.ts"]!;

  it("child proxies return the parent's RPC result", () => {
    expect(cf).toContain("return await parent.onAgentEvent(");
  });

  it("the dispatcher returns the invoked closure's awaited result", () => {
    // callback branch must produce a value, not just invoke
    const callbackBranch = cf.slice(cf.indexOf("payload.callback"), cf.indexOf("const key = payload.key"));
    expect(callbackBranch).toContain("const result = await");
    expect(callbackBranch).toContain("return result;");
  });

  it("generates callback refs only from explicit bindings and rejects ungranted calls", () => {
    expect(cf).toContain("Object.entries(rec.bindings ?? {})");
    expect(cf).toContain("capability: capability.kind");
    expect(cf).toContain("unauthorized agent capability");
  });
});
