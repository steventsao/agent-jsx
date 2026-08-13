import { describe, expect, it } from "bun:test";
import {
  Agent,
  callable,
  compileAgentClass,
  composeAgent,
  result,
} from "../src/agent-class.tsx";
import { emitCloudflare, type ChildAgentSpec } from "../src/compile/emit-cloudflare.ts";
import { evaluateComponent } from "../src/compile/evaluate.ts";
import { emitFlue, emitFlueChild, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { analyzeAgent, discoverAgents, type AgentModule } from "../src/compile/graph.ts";
import { emitThink } from "../src/compile/emit-think.ts";
import { createStore } from "../src/store.ts";
import { collectInfra, collectPrompt } from "../src/tree.ts";

let renderCalls = 0;

interface IsolationState extends Record<string, unknown> {
  results: string[];
}

class IsolationRootAgent extends Agent<IsolationState> {
  static agentName = "isolation-root";
  model = "test/isolation-root";
  initialState: IsolationState = { results: [] };

  @callable()
  recordResult(value: string) {
    this.setState((state) => ({ ...state, results: [...state.results, value] }));
  }

  getPrompt() {
    return "Control-plane prompt from getPrompt only.";
  }

  getTools() {
    return {
      legitimateTool: {
        description: "A real compiler-visible tool.",
        execute: () => "ok",
      },
    };
  }

  render() {
    renderCalls += 1;
    return (
      <>
        <subagent name="leaked-from-render" kind="ghost" />
        <tool name="ghost-tool" description="Must remain UI-only." run={() => "ghost"} />
      </>
    );
  }
}

interface IsolationChildProps {
  request: string;
  onResult: (value: string) => void | Promise<void>;
}

class IsolationChildAgent extends Agent<{ calls: number }, IsolationChildProps> {
  static agentName = "isolation-child";
  model = "test/isolation-child";
  initialState = { calls: 0 };

  getPrompt() {
    return `Child prompt for ${this.props.request}.`;
  }

  getTools() {
    return {
      childTool: {
        description: "A real child tool.",
        execute: () => "child-ok",
      },
    };
  }

  render() {
    renderCalls += 1;
    return (
      <>
        <subagent name="leaked-from-render" kind="ghost" />
        <tool name="ghost-tool" description="Must remain UI-only." run={() => "ghost"} />
      </>
    );
  }
}

const IsolationRoot = compileAgentClass(IsolationRootAgent);
const IsolationChild = compileAgentClass(IsolationChildAgent);

const IsolationComposition = composeAgent(
  <IsolationRoot name="isolation">
    {({ recordResult }) => (
      <IsolationChild
        name="child:primary"
        request="resolve the isolation contract"
        onResult={result(recordResult)}
      />
    )}
  </IsolationRoot>,
);

const rootModule: AgentModule = {
  spec: IsolationComposition.spec,
  exportName: "IsolationComposition",
  importPath: "./render-isolation.tsx",
};

const childModule: AgentModule = {
  spec: IsolationChild.spec,
  exportName: "IsolationChild",
  importPath: "./render-isolation-child.tsx",
};

const ghostRecord = (record: { name: string; config: Record<string, unknown> }) =>
  record.name === "leaked-from-render" ||
  record.name === "ghost-tool" ||
  record.config.kind === "ghost";

const expectNoGhostSource = (source: string) => {
  expect(source).not.toContain("leaked-from-render");
  expect(source).not.toContain("ghost-tool");
  expect(source).not.toContain("ghost");
};

describe("render isolation", () => {
  it("keeps render() out of evaluation, discovery, and every emitter", () => {
    renderCalls = 0;

    const roots = evaluateComponent(IsolationComposition.spec.impl, {
      store: createStore<IsolationState>({ results: [] }),
      emit: () => {},
    });
    const infra = roots.flatMap((root) => collectInfra(root));

    expect(infra.some(ghostRecord)).toBe(false);
    expect(collectPrompt(roots).map((block) => block.text)).toEqual([
      "Control-plane prompt from getPrompt only.",
    ]);

    const rootAnalysis = analyzeAgent(rootModule);
    expect([...rootAnalysis.static, ...rootAnalysis.dynamic].some(ghostRecord)).toBe(false);

    const graph = discoverAgents(rootModule, [childModule]);
    expect(graph.map((node) => node.spec.agentName)).toEqual([
      "isolation-root",
      "isolation-child",
    ]);
    expect(graph.flatMap((node) => node.directChildren)).not.toContain("ghost");
    expect(
      graph
        .flatMap((node) => [...node.analysis.static, ...node.analysis.dynamic])
        .some(ghostRecord),
    ).toBe(false);

    const children: ChildAgentSpec[] = graph.slice(1).map((node) => ({
      spec: node.spec,
      exportName: node.exportName,
      importPath: node.importPath,
    }));
    const root = {
      spec: graph[0]!.spec,
      componentName: graph[0]!.exportName,
      componentImport: graph[0]!.importPath,
    };

    const cloudflare = emitCloudflare(root, children, graph[0]!.analysis, {
      runtimeImport: "./runtime",
    });
    const think = emitThink(root, children, graph[0]!.analysis, {
      runtimeImport: "./runtime",
    });
    const flue = emitFlue({
      spec: graph[0]!.spec,
      componentName: graph[0]!.exportName,
      componentImport: graph[0]!.importPath,
      analysis: graph[0]!.analysis,
      childProfiles: graph[0]!.directChildren.map((kind) => ({
        importPath: `./${kind}.flue.ts`,
        profileExportName: flueProfileExportName(kind),
      })),
      runtimeImport: "./runtime",
    });
    const flueChildren = graph.slice(1).map((node) =>
      emitFlueChild(
        { spec: node.spec, exportName: node.exportName, importPath: node.importPath },
        400,
        {
          runtimeImport: "./runtime",
          analysis: node.analysis,
          childProfiles: node.directChildren.map((kind) => ({
            importPath: `./${kind}.flue.ts`,
            profileExportName: flueProfileExportName(kind),
          })),
        },
      ),
    );

    for (const source of [
      cloudflare.agents,
      cloudflare.wrangler,
      think.agents,
      think.wrangler,
      flue,
      ...flueChildren,
    ]) {
      expectNoGhostSource(source);
    }

    expect(renderCalls).toBe(0);
  });
});
