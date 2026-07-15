/**
 * TOOL-SLOT MAPPING — Steven's acceptance example, verbatim target:
 *
 *   <Coordinator name="coord">
 *     {(handleCall) => <Worker onCall={handleCall} />}
 *   </Coordinator>
 *
 * compiles (agentTools mode) to, in CoordinatorDurable:
 *
 *   getTools() { return { onCall: agentTool(ToolWorkerDurable, {
 *     description: Worker.spec.description, inputSchema: Worker.spec.inputSchema }) } }
 *
 * Contract under test:
 *   - a tool-slot provider's continuation receives a capability slot HANDLE (a
 *     marker), identity-recognized — distinguished from an output continuation by
 *     TYPE, never syntax;
 *   - binding the handle to a child boundary's prop registers a model-tool named
 *     after the PROP KEY, targeting that child, schema'd by the child's spec;
 *   - the SAME coordinator, composed with a different child that satisfies the
 *     slot, binds that child instead — hierarchy comes from the composition site;
 *   - discovery still finds the child; the handle flows through evaluate parity;
 *   - the flue target exposes the same child as a native `subagents:` roster;
 *   - the getTools block is version-gated OFF by default (zero-churn).
 */

import { describe, expect, it } from "bun:test";
import { isToolSlotHandle } from "../src/agent-component.tsx";
import { withOutputs } from "../src/store.ts";
import { collectInfra } from "../src/tree.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { analyzeAgent } from "../src/compile/graph.ts";
import { discoverToolSlots } from "../src/compile/slots.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { emitFlue, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { Coordinator } from "../examples/tool-slot/coordinator.tsx";
import { Worker } from "../examples/tool-slot/worker.tsx";
import { Summarizer } from "../examples/tool-slot/summarizer.tsx";

// The verbatim composition — a coordinator that names no child, its slot filled
// by `Worker` bound to the `onCall` prop. A fresh element per call.
const withWorker = () => (
  <Coordinator name="coord">{(handleCall) => <Worker name="w" onCall={handleCall} />}</Coordinator>
);
const withSummarizer = () => (
  <Coordinator name="coord">{(handleCall) => <Summarizer name="s" onCall={handleCall} />}</Coordinator>
);

const coordinatorRoot = { spec: Coordinator.spec, componentName: "Coordinator", componentImport: "./coordinator.tsx" };
const coordinatorAnalysis = () =>
  analyzeAgent({ spec: Coordinator.spec, exportName: "Coordinator", importPath: "./coordinator.tsx" });

const emitCf = (
  child: typeof Worker | typeof Summarizer,
  exportName: string,
  composition: () => unknown
) =>
  emitCloudflare(
    coordinatorRoot,
    [{ spec: child.spec, exportName, importPath: `./${exportName.toLowerCase()}.tsx` }],
    coordinatorAnalysis(),
    { runtimeImport: "./runtime", agentTools: true, toolSlots: discoverToolSlots(composition()) }
  ).agents;

describe("tool-slot mapping — discovery", () => {
  it("reads the binding: prop key → tool name, child kind, provider", () => {
    expect(discoverToolSlots(withWorker())).toEqual([
      { toolName: "onCall", childKind: "tool-worker", provider: "coordinator", stableId: "w" },
    ]);
    // the SAME coordinator, a different child filling the same slot
    expect(discoverToolSlots(withSummarizer())).toEqual([
      { toolName: "onCall", childKind: "tool-summarizer", provider: "coordinator", stableId: "s" },
    ]);
  });
});

describe("tool-slot mapping — the emitted getTools block (agentTools mode)", () => {
  it("binds worker: onCall → agentTool(ToolWorkerDurable, { description, inputSchema })", () => {
    const cf = emitCf(Worker, "Worker", withWorker);
    expect(cf).toContain('import { agentTool } from "agents/agent-tools";');
    expect(cf).toContain("getTools() {");
    expect(cf).toContain(
      "onCall: agentTool(ToolWorkerDurable, { description: Worker.spec.description ?? \"onCall\", displayName: Worker.spec.displayName, inputSchema: Worker.spec.inputSchema, outputSchema: Worker.spec.outputSchema }),"
    );
  });

  it("the SAME coordinator, composed with summarizer, binds the summarizer instead", () => {
    const cf = emitCf(Summarizer, "Summarizer", withSummarizer);
    expect(cf).toContain(
      "onCall: agentTool(ToolSummarizerDurable, { description: Summarizer.spec.description ?? \"onCall\", displayName: Summarizer.spec.displayName, inputSchema: Summarizer.spec.inputSchema, outputSchema: Summarizer.spec.outputSchema }),"
    );
    expect(cf).not.toContain("ToolWorkerDurable");
  });

  it("is version-gated OFF by default: no getTools, no agent-tools import (zero-churn)", () => {
    const cf = emitCloudflare(
      coordinatorRoot,
      [{ spec: Worker.spec, exportName: "Worker", importPath: "./worker.tsx" }],
      coordinatorAnalysis(),
      { runtimeImport: "./runtime" } // agentTools omitted
    ).agents;
    expect(cf).not.toContain("getTools()");
    expect(cf).not.toContain("agent-tools");
  });
});

describe("tool-slot mapping — the slot handle flows through evaluate parity", () => {
  it("React commit and the walker agree on records under sample expansion; the handle is identity-recognized", () => {
    const walkerRecs = withOutputs({ outputs: {}, setOutput: () => {}, expandSamples: true }, () =>
      evaluateTree(withWorker()).flatMap((r) => collectInfra(r))
    );

    const host = new SimHost({ statusAt: () => 200 });
    mountAgent(withWorker(), host, { quiet: true, expandSamples: true });
    const reactKeys = [...host.liveRecords.keys()].sort();
    const walkerKeys = walkerRecs.map((r) => `${r.kind}:${r.name}`).sort();

    expect(reactKeys).toEqual(walkerKeys); // the parity theorem, slot-handle case
    expect(walkerKeys).toContain("subagent:w"); // discovery still finds the child
    // the marker flowed through as the onCall prop value, recognized by identity
    const workerRec = walkerRecs.find((r) => r.name === "w");
    expect(isToolSlotHandle(workerRec?.config.onCall)).toBe(true);
    expect((workerRec?.config.onCall as { provider: string }).provider).toBe("coordinator");
  });

  it("at RUNTIME (no expansion) the slot does not mount a standing child — a tool, not a subagent", () => {
    const host = new SimHost({ statusAt: () => 200 });
    mountAgent(withWorker(), host, { quiet: true });
    const keys = [...host.liveRecords.keys()];
    expect(keys).toContain("subagent:coord");
    expect(keys).not.toContain("subagent:w");
  });
});

describe("tool-slot mapping — flue exposes the same child as a native subagent roster", () => {
  const flueFor = (kind: string, composition: () => unknown) =>
    emitFlue({
      spec: Coordinator.spec,
      model: "openrouter/google/gemini-3.1-flash-lite-preview",
      componentName: "Coordinator",
      componentImport: "./coordinator.tsx",
      analysis: coordinatorAnalysis(),
      childProfiles: [{ importPath: `./${kind}.flue.ts`, profileExportName: flueProfileExportName(kind) }],
      runtimeImport: "./runtime",
      toolSlots: discoverToolSlots(composition()),
    });

  it("worker composition → subagents: [tool_workerProfile]", () => {
    const flue = flueFor("tool-worker", withWorker);
    expect(flue).toContain('import { tool_workerProfile } from "./tool-worker.flue.ts";');
    expect(flue).toContain('onCallSubagentProfile = defineAgentProfile({ ...tool_workerProfile, name: "onCall" })');
    expect(flue).toContain("subagents: [onCallSubagentProfile],");
  });

  it("summarizer composition → subagents: [tool_summarizerProfile] (same declaration, different fill)", () => {
    const flue = flueFor("tool-summarizer", withSummarizer);
    expect(flue).toContain("subagents: [onCallSubagentProfile],");
  });
});
