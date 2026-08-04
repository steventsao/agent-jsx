/**
 * Why `onResult={result(handleGoalEvent)}` and NOT a plain function prop.
 *
 * Pins the four claims behind the branded grant, end to end on the class-agent
 * path (the README/ChessMatch shape):
 *
 *  1. A bare function prop at a boundary is REJECTED at render time
 *     (src/agent-component.tsx): no `capabilities` declaration and no
 *     `result()` brand means no grant. Nesting alone grants nothing.
 *  2. `result(fn)` lowers to serializable binding METADATA on the record
 *     (`bindings.onResult = { kind: "result" }`); the closure itself never
 *     enters `config` — it rides host-side in `handlers` (src/tree.ts split).
 *  3. The child never holds the function. The HOST invokes the parent-side
 *     sink when the child's work completes (SimHost.armSubagent →
 *     resultBindingName), so "a function the agent can call" is not the
 *     contract even for a granted callable.
 *  4. Closures cannot survive hibernation: snapshot() persists only
 *     (kind, name, config); a restored record's handlers are dead until the
 *     next commit rebinds a fresh closure. Only the branded ROUTE is durable —
 *     a raw function prop could never be.
 */

import { describe, expect, it } from "bun:test";
import {
  Agent,
  compileAgentClass,
  result,
} from "../src/agent-class.tsx";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { collectInfra, resultBindingName } from "../src/tree.ts";
import { SimHost, type World } from "../src/sim-host.ts";

interface WorkerProps {
  task: string;
  onResult: (value: string) => void;
}

interface WorkerState extends Record<string, unknown> {
  runs: number;
}

class WorkerAgent extends Agent<WorkerState, WorkerProps> {
  static agentName = "goal-worker";
  initialState: WorkerState = { runs: 0 };

  render() {
    return this.define({
      model: "test/worker-model",
      description: "Executes one goal milestone.",
    });
  }
}

const Worker = compileAgentClass(WorkerAgent);

const flush = (fn: () => void) => fn();

const evaluateWorker = (onResult: WorkerProps["onResult"]) =>
  evaluateTree(<Worker name="worker:run-ci" task="run-ci" onResult={onResult} />)
    .flatMap((root) => collectInfra(root));

describe("result grant — a plain function prop is not a capability", () => {
  it("rejects a bare function prop at render time (the type system allows it; the boundary does not)", () => {
    expect(() => evaluateWorker((value) => void value)).toThrow(
      '[agent-jsx] boundary "worker:run-ci" (kind goal-worker): function prop "onResult" has no explicit capability declaration'
    );
  });

  it("accepts the branded grant and lowers it to serializable metadata, never child input", () => {
    const record = evaluateWorker(result((value) => void value))[0];
    expect(record?.bindings).toEqual({ onResult: { kind: "result" } });
    expect(resultBindingName(record!)).toBe("onResult");
    // The child's durable input is serializable config only — no closure.
    expect(record?.config).toEqual({ kind: "goal-worker", task: "run-ci" });
    expect(Object.keys(record?.handlers ?? {})).toEqual(["onResult"]);
  });
});

describe("result grant — the host, not the child, invokes the sink", () => {
  const armedWorld: World = {
    statusAt: () => 200,
    subagentLatency: 2,
    subagentResult: () => "MILESTONE_DONE(run-ci)",
  };

  it("routes the child's completed work into the parent-side sink after latency", () => {
    const received: string[] = [];
    const desired = evaluateWorker(result((value) => received.push(value)));

    const host = new SimHost(armedWorld);
    host.reconcile(desired);

    host.tick(flush); // t=1 — not due
    expect(received).toEqual([]);
    host.tick(flush); // t=2 — host completes the subagent and calls the sink
    expect(received).toEqual(["MILESTONE_DONE(run-ci)"]);
  });

  it("hibernation keeps the route, kills the closure — until a commit rebinds it", () => {
    const received: string[] = [];
    const desired = evaluateWorker(result((value) => received.push(value)));
    const host = new SimHost(armedWorld);
    host.reconcile(desired);

    // Only (kind, name, config) survive. The function was never persistable.
    const persisted = JSON.parse(host.snapshot()) as Array<Record<string, unknown>>;
    expect(persisted).toEqual([
      {
        kind: "subagent",
        name: "worker:run-ci",
        config: { kind: "goal-worker", task: "run-ci" },
      },
    ]);

    // Restored without a commit: work re-arms, but the dead handler grants nothing.
    const dormant = SimHost.restore(host.snapshot(), armedWorld, 0);
    dormant.tick(flush);
    dormant.tick(flush); // due — completes, but no rebound sink to call
    expect(received).toEqual([]);

    // A fresh commit rebinds a live closure onto the same durable identity.
    const rebound = SimHost.restore(host.snapshot(), armedWorld, 0);
    rebound.reconcile(evaluateWorker(result((value) => received.push(value))));
    rebound.tick(flush);
    rebound.tick(flush);
    expect(received).toEqual(["MILESTONE_DONE(run-ci)"]);
  });
});
