import { describe, expect, it } from "bun:test";
import { Agent, compileAgentClass, composeAgent } from "../src/agent-class.tsx";
import { emitCloudflare, type ChildAgentSpec } from "../src/compile/emit-cloudflare.ts";
import { emitFlue, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { discoverAgents, type AgentModule } from "../src/compile/graph.ts";

class OrchestratorAgent extends Agent<Record<string, never>> {
  static agentName = "orchestrator";
  model = "test/orchestrator";
  initialState = {};

  getPrompt() {
    return "Coordinate the requested work.";
  }
}

class WorkerAgent extends Agent<Record<string, never>> {
  static agentName = "worker";
  model = "test/worker";
  initialState = {};

  getPrompt() {
    return "Complete one unit of work.";
  }
}

const Orchestrator = compileAgentClass(OrchestratorAgent);
const Worker = compileAgentClass(WorkerAgent);

const WithoutWorker = composeAgent(
  <Orchestrator name="orchestrator">{() => null}</Orchestrator>,
);

const WithWorker = composeAgent(
  <Orchestrator name="orchestrator">
    {() => <Worker name="worker:primary" />}
  </Orchestrator>,
);

const workerModule: AgentModule = {
  spec: Worker.spec,
  exportName: "Worker",
  importPath: "./worker.tsx",
};

const rootModule = (spec: typeof WithoutWorker.spec): AgentModule => ({
  spec,
  exportName: "Orchestrator",
  importPath: "./orchestrator.tsx",
});

const cloudflareFor = (graph: ReturnType<typeof discoverAgents>) => {
  const root = graph[0]!;
  const children: ChildAgentSpec[] = graph.slice(1).map((node) => ({
    spec: node.spec,
    exportName: node.exportName,
    importPath: node.importPath,
  }));
  return emitCloudflare(
    {
      spec: root.spec,
      componentName: root.exportName,
      componentImport: root.importPath,
    },
    children,
    root.analysis,
    { runtimeImport: "./runtime" },
  ).agents;
};

const flueFor = (graph: ReturnType<typeof discoverAgents>) => {
  const root = graph[0]!;
  return emitFlue({
    spec: root.spec,
    componentName: root.exportName,
    componentImport: root.importPath,
    analysis: root.analysis,
    childProfiles: root.directChildren.map((kind) => ({
      importPath: `./${kind}.flue.ts`,
      profileExportName: flueProfileExportName(kind),
    })),
    runtimeImport: "./runtime",
  });
};

describe("hierarchy comes only from JSX", () => {
  it("does not infer a worker child from class or agent names", () => {
    const graph = discoverAgents(rootModule(WithoutWorker.spec), [workerModule]);

    expect(graph.map((node) => node.spec.agentName)).toEqual(["orchestrator"]);
    expect(graph[0]!.directChildren).toEqual([]);

    const cloudflare = cloudflareFor(graph);
    expect(cloudflare).toContain("protected childBinding = {};");
    expect(cloudflare).not.toContain('"worker": "WORKER",');
    expect(cloudflare).not.toContain("WORKER: DurableObjectNamespace;");

    const flue = flueFor(graph);
    expect(flue).not.toContain("workerProfile");
    expect(flue).not.toContain("subagents:");
  });

  it("creates the worker hierarchy only when the JSX nests its boundary", () => {
    const graph = discoverAgents(rootModule(WithWorker.spec), [workerModule]);

    expect(graph.map((node) => node.spec.agentName)).toEqual(["orchestrator", "worker"]);
    expect(graph[0]!.directChildren).toEqual(["worker"]);

    const cloudflare = cloudflareFor(graph);
    expect(cloudflare).toContain('"worker": "WORKER",');
    expect(cloudflare).toContain("WORKER: DurableObjectNamespace;");

    const flue = flueFor(graph);
    expect(flue).toContain('import { workerProfile } from "./worker.flue.ts";');
    expect(flue).toContain("subagents: [workerProfile]");
  });
});
