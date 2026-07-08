/**
 * CONTINUATION NESTING at runtime — function-as-children on a boundary:
 *
 *   <Producer name="p:1">{(items) => items.map((i) => <Consumer name={`c:${i}`} …/>)}</Producer>
 *
 * Semantics under test (the design contract):
 *   - the child's emitted output lands in the PARENT's reserved `__outputs`
 *     slot and re-renders the parent;
 *   - the continuation is pure and parent-owned: its records are the parent's
 *     DIRECT children, mounted only once an output exists;
 *   - a changed output converges the grandchildren by `name` (stale removed);
 *   - the React commit path and the react-free walker agree byte-for-byte
 *     under the same outputs context (the parity theorem, continuation case);
 *   - the generated cloudflare module carries the reserved `__emit` routing
 *     that writes `__outputs` durably.
 */

import { describe, expect, it } from "bun:test";
import { agentComponent } from "../src/agent-component.tsx";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore, withOutputs } from "../src/store.ts";
import { collectInfra } from "../src/tree.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { discoverAgents } from "../src/compile/graph.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { useAgentState } from "../src/state.ts";

const Consumer = agentComponent<{ item: string }, Record<string, never>>({
  agentName: "consumer",
  initialState: {},
  impl: () => (
    <prompt>
      <sys p={10}>Consume one item.</sys>
    </prompt>
  ),
});

const Producer = agentComponent<Record<string, unknown>, Record<string, never>, string[]>({
  agentName: "producer",
  initialState: {},
  sampleOutput: ["a", "b"],
  impl: ({ emit }) => (
    <>
      <task name="produce" run={() => ["a", "b"]} onDone={(v) => emit?.(v as string[])} />
      <prompt>
        <sys p={10}>Produce the items.</sys>
      </prompt>
    </>
  ),
});

interface ParentState extends Record<string, unknown> {
  folded: string[];
}

const Parent = agentComponent<Record<string, unknown>, ParentState>({
  agentName: "cont-parent",
  initialState: { folded: [] },
  impl: ({ store }) => {
    useAgentState(store);
    return (
      <>
        <Producer name="p:1">
          {(items) => items.map((item) => <Consumer key={item} name={`c:${item}`} item={item} />)}
        </Producer>
        <prompt>
          <sys p={10}>Fan out one consumer per produced item.</sys>
        </prompt>
      </>
    );
  },
});

const names = (host: SimHost) => [...host.liveRecords.keys()].filter((k) => k.startsWith("subagent:"));

describe("continuation nesting — live sim", () => {
  it("mounts grandchildren only once the child emits; converges on output change", () => {
    const world = {
      statusAt: () => 200,
      // The producer completes with a STRUCTURED output — delivered to the
      // boundary's reserved __emit before onResult.
      subagentResult: (live: { name: string }) => (live.name === "p:1" ? ["a", "b"] : "done"),
    };
    const host = new SimHost(world);
    const store = createStore<ParentState & Record<string, unknown>>({ folded: [] });
    const ParentImpl = Parent.spec.impl;
    const handle = mountAgent(<ParentImpl store={store} emit={() => {}} />, host, { quiet: true });

    // Before any emission: the boundary exists, the continuation contributes nothing.
    expect(names(host)).toEqual(["subagent:p:1"]);

    // Producer completes (default latency 2 ticks) → emit → __outputs → re-render.
    handle.tick();
    handle.tick();
    expect(names(host).sort()).toEqual(["subagent:c:a", "subagent:c:b", "subagent:p:1"]);

    // The emitted output is durable state, not a closure artifact.
    const outputs = (store.get() as { __outputs?: Record<string, unknown> }).__outputs;
    expect(outputs?.["p:1"]).toEqual(["a", "b"]);

    // Output changes → continuation converges by name: c:a removed, c:z added.
    handle.dispatch(() =>
      store.set(
        (s) =>
          ({
            ...s,
            __outputs: { ...(s as { __outputs?: object }).__outputs, "p:1": ["b", "z"] },
          }) as never
      )
    );
    expect(names(host).sort()).toEqual(["subagent:c:b", "subagent:c:z", "subagent:p:1"]);
  });
});

describe("continuation nesting — parity", () => {
  it("React commit path and the walker agree on the desired records under the same outputs", () => {
    const outputs = { "p:1": ["x", "y"] };

    // Walker path: evaluate inside the outputs context.
    const walkerRecords = withOutputs({ outputs, setOutput: () => {} }, () =>
      evaluateTree({
        type: Parent.spec.impl,
        props: { store: createStore({ folded: [] }), emit: () => {} },
      } as never).flatMap((root) => collectInfra(root))
    );

    // React path: mount with the same outputs pre-seeded in the store slot.
    const host = new SimHost({ statusAt: () => 200 });
    const store = createStore<ParentState & Record<string, unknown>>({ folded: [], __outputs: outputs });
    const ParentImpl = Parent.spec.impl;
    mountAgent(<ParentImpl store={store} emit={() => {}} />, host, { quiet: true });
    const liveKeys = [...host.liveRecords.keys()].sort();
    const walkerKeys = walkerRecords.map((r) => `${r.kind}:${r.name}`).sort();
    expect(liveKeys).toEqual(walkerKeys);
    expect(walkerKeys).toContain("subagent:c:x");
    expect(walkerKeys).toContain("subagent:c:y");
  });
});

describe("continuation nesting — compiled artifact", () => {
  it("the generated cloudflare module routes __emit into durable __outputs", () => {
    const graph = discoverAgents(
      { spec: Parent.spec, exportName: "Parent", importPath: "./parent.tsx" },
      [
        { spec: Producer.spec, exportName: "Producer", importPath: "./producer.tsx" },
        { spec: Consumer.spec, exportName: "Consumer", importPath: "./consumer.tsx" },
      ]
    );
    const out = emitCloudflare(
      { spec: graph[0]!.spec, componentName: "Parent", componentImport: "./parent.tsx" },
      graph.slice(1).map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath })),
      graph[0]!.analysis,
      { runtimeImport: "./runtime" }
    ).agents;
    expect(out).toContain("__outputs");
    expect(out).toContain("__emit");
    // continuation kinds are discovered: the parent binds BOTH children.
    const parentBlock = out.slice(out.indexOf("class ContParentDurable"));
    expect(parentBlock).toContain(`"producer": "PRODUCER",`);
    expect(parentBlock).toContain(`"consumer": "CONSUMER",`);
  });
});
