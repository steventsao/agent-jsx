/**
 * SimHost durability and op-log contract (src/sim-host.ts).
 *
 * snapshot()/restore() is "hibernation": only (kind, name, config) survive —
 * restored records are inert (`dormant: true`, empty handlers) until the next
 * reconcile rebinds fresh closures, which is what the `rebind` op records.
 * Restore re-arms in-flight subagent/task work (what DO alarms do on wake);
 * handlers resolve at fire time, so the post-wake reconcile supplies them.
 * Removing a record cancels its in-flight work. `update` ops carry the exact
 * changed config keys; handler-only refreshes are not ops. formatOps renders
 * the op log.
 */

import { describe, expect, it } from "bun:test";
import { formatOps, SimHost, type World } from "../src/sim-host.ts";
import type { InfraRecord } from "../src/types.ts";

const world: World = { statusAt: () => 200 };
const flush = (fn: () => void) => fn();

const sensorRecord = (onStatus: (status: number) => void): InfraRecord => ({
  kind: "sensor",
  name: "watch",
  config: { interval: 2, url: "https://a.example" },
  handlers: { onStatus },
});

describe("SimHost snapshot/restore — hibernation", () => {
  it("snapshot serializes only kind/name/config — never handlers or bindings", () => {
    const host = new SimHost(world);
    host.reconcile([
      sensorRecord(() => {}),
      {
        kind: "subagent",
        name: "w",
        config: { site: "a" },
        handlers: { onResult: () => {} },
        bindings: { onResult: { kind: "result" } },
      },
    ]);

    expect(JSON.parse(host.snapshot())).toEqual([
      { kind: "sensor", name: "watch", config: { interval: 2, url: "https://a.example" } },
      { kind: "subagent", name: "w", config: { site: "a" } },
    ]);
  });

  it("restored records are dormant and inert until a commit rebinds them", () => {
    const host = new SimHost(world);
    host.reconcile([sensorRecord(() => {})]);
    const snapshot = host.snapshot();

    const restored = SimHost.restore(snapshot, world, 4);
    expect(restored.t).toBe(4);
    expect(restored.liveRecords.get("sensor:watch")?.dormant).toBe(true);

    // Dormant records do not fire even on their interval (t=6 % 2 === 0).
    restored.tick(flush); // t=5
    restored.tick(flush); // t=6
    expect(restored.opLog).toEqual([]);
  });

  it("an unchanged re-commit of a dormant record emits a `rebind` op and revives handlers", () => {
    const host = new SimHost(world);
    host.reconcile([sensorRecord(() => {})]);
    const restored = SimHost.restore(host.snapshot(), world, 4);

    const statuses: number[] = [];
    const ops = restored.reconcile([sensorRecord((status) => statuses.push(status))]);

    expect(ops).toEqual([{ op: "rebind", kind: "sensor", name: "watch" }]);
    expect(restored.liveRecords.get("sensor:watch")?.dormant).toBe(false);

    restored.tick(flush); // t=5 — not on the interval
    expect(statuses).toEqual([]);
    restored.tick(flush); // t=6 — fires with the fresh closure
    expect(statuses).toEqual([200]);
  });

  it("restore re-arms in-flight subagent work; the post-wake commit supplies the handlers", () => {
    const record = (onResult: (value: unknown) => void): InfraRecord => ({
      kind: "subagent",
      name: "w",
      config: { site: "a" },
      handlers: { onResult },
      bindings: { onResult: { kind: "result" } },
    });
    const armedWorld: World = {
      statusAt: () => 200,
      subagentLatency: 2,
      subagentResult: () => "report",
    };
    const host = new SimHost(armedWorld);
    host.reconcile([record(() => {})]); // armed at t=0, due at t=2

    const restored = SimHost.restore(host.snapshot(), armedWorld, 0);
    const results: unknown[] = [];
    restored.reconcile([record((value) => results.push(value))]);

    restored.tick(flush); // t=1 — not due
    expect(results).toEqual([]);
    restored.tick(flush); // t=2 — completes with the rebound handler
    expect(results).toEqual(["report"]);
  });
});

describe("SimHost reconcile — op recording", () => {
  it("an `update` op records exactly the changed config keys", () => {
    const host = new SimHost(world);
    host.reconcile([
      { kind: "subagent", name: "w", config: { a: 1, b: "x" }, handlers: {} },
    ]);

    const ops = host.reconcile([
      { kind: "subagent", name: "w", config: { a: 2, b: "x", c: true }, handlers: {} },
    ]);

    expect(ops).toEqual([{ op: "update", kind: "subagent", name: "w", changed: ["a", "c"] }]);
  });

  it("a removed config key counts as a change", () => {
    const host = new SimHost(world);
    host.reconcile([
      { kind: "subagent", name: "w", config: { a: 1 }, handlers: {} },
    ]);

    const ops = host.reconcile([
      { kind: "subagent", name: "w", config: {}, handlers: {} },
    ]);

    expect(ops).toEqual([{ op: "update", kind: "subagent", name: "w", changed: ["a"] }]);
  });

  it("a handler-only refresh is not an op (same as re-rendering onClick)", () => {
    const host = new SimHost(world);
    host.reconcile([sensorRecord(() => {})]);

    const ops = host.reconcile([sensorRecord(() => {})]);

    expect(ops).toEqual([]);
  });

  it("removing a record cancels its in-flight subagent work", () => {
    const results: unknown[] = [];
    const host = new SimHost({
      statusAt: () => 200,
      subagentLatency: 3,
      subagentResult: () => "late-report",
    });
    host.log = () => {}; // keep the ✂ cancellation notice out of test output
    host.reconcile([
      {
        kind: "subagent",
        name: "w",
        config: {},
        handlers: { onResult: (value: unknown) => results.push(value) },
        bindings: { onResult: { kind: "result" } },
      },
    ]);
    host.tick(flush); // t=1 — work armed, due at t=3

    const ops = host.reconcile([]); // unmounted before completion
    expect(ops).toEqual([{ op: "remove", kind: "subagent", name: "w" }]);

    for (let i = 0; i < 5; i++) host.tick(flush); // well past the due tick
    expect(results).toEqual([]);
  });
});

describe("formatOps", () => {
  it("renders each op with its symbol, padded tick, and changed keys for updates", () => {
    const lines = formatOps(
      [
        { op: "create", kind: "sensor", name: "watch" },
        { op: "update", kind: "subagent", name: "w", changed: ["site", "turn"] },
        { op: "remove", kind: "task", name: "once" },
        { op: "rebind", kind: "subagent", name: "w" },
      ],
      3
    );

    expect(lines).toEqual([
      "t= 3  + sensor watch",
      "t= 3  ~ subagent w (site, turn)",
      "t= 3  - task once",
      "t= 3  ↻ subagent w",
    ]);
  });
});
