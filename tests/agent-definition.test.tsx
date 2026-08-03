/**
 * Contract for the class authoring seam. `render()` is the complete,
 * model-facing agent definition; it is never a UI projection.
 */

import { describe, expect, it } from "bun:test";
import { Agent, compileAgentClass } from "../src/agent-class.tsx";
import { agentComponent } from "../src/agent-component.tsx";
import type {
  AgentSkillSource,
  AgentToolSet,
  McpServerDefinitions,
} from "../src/types.ts";
import { evaluateComponent } from "../src/compile/evaluate.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { emitThink } from "../src/compile/emit-think.ts";
import { analyzeAgent } from "../src/compile/graph.ts";
import { collectInfra, collectPrompt } from "../src/tree.ts";
import { createStore } from "../src/store.ts";

interface ResearchState extends Record<string, unknown> {
  searches: number;
}

interface ResearchProps extends Record<string, unknown> {
  topic: { title: string };
}

const sourceReviewSkill = {
  id: "source-review",
  fingerprint: "source-review-v1",
  async list() {
    return [{ name: "source-review", description: "Review source quality." }];
  },
  async load(name: string) {
    return name === "source-review"
      ? { name, description: "Review source quality.", body: "Check provenance." }
      : null;
  },
} satisfies AgentSkillSource;

const searchInputSchema = {
  parse(value: unknown) {
    return value as { query?: string };
  },
};

class ResearchAgent extends Agent<ResearchState, ResearchProps> {
  static agentName = "research";
  initialState: ResearchState = { searches: 0 };

  render() {
    return this.define({
      model: "openrouter/openai/gpt-5-mini",
      displayName: "Researcher",
      description: "Researches a topic with approved sources.",
      prompt: (
        <prompt>
          <sys p={10}>Research carefully.</sys>
          <msg p={8}>Topic: {this.props.topic.title}</msg>
        </prompt>
      ),
      tools: {
        search: {
          description: "Search the approved corpus.",
          inputSchema: searchInputSchema,
          needsApproval: true,
          execute: () => {
            this.setState((state) => ({ ...state, searches: state.searches + 1 }));
            return { result: `searched:${this.props.topic.title}` };
          },
        },
      },
      skills: [sourceReviewSkill],
      mcpServers: {
        docs: {
          url: "https://mcp.example.com/docs",
          transport: "streamable-http",
        },
      },
    });
  }
}

const Research = compileAgentClass(ResearchAgent);
const sampleProps: ResearchProps = { topic: { title: "agent runtimes" } };

describe("Agent.render — complete agent definition", () => {
  it("normalizes model, prompt, tools, skills, and MCP from one render without flattening tools", async () => {
    const store = createStore<ResearchState>({ searches: 0 });
    const definition = Research.spec.resolveDefinition!(sampleProps, store);
    const roots = evaluateComponent(Research.spec.impl, {
      ...sampleProps,
      store,
      emit: () => {},
    });

    expect(definition).toMatchObject({
      model: "openrouter/openai/gpt-5-mini",
      displayName: "Researcher",
      description: "Researches a topic with approved sources.",
      skills: [sourceReviewSkill],
      mcpServers: {
        docs: {
          url: "https://mcp.example.com/docs",
          transport: "streamable-http",
        },
      },
    });
    expect(collectPrompt(roots).map((block) => block.text)).toEqual([
      "Research carefully.",
      "Topic: agent runtimes",
    ]);
    const search = definition.tools.search as {
      inputSchema: unknown;
      needsApproval: boolean;
      execute(): Promise<unknown> | unknown;
    };
    expect(search.inputSchema).toBe(searchInputSchema);
    expect(search.needsApproval).toBe(true);
    expect(await search.execute()).toEqual({ result: "searched:agent runtimes" });
    expect(store.get().searches).toBe(1);
  });

  it("publishes class input and output schemas as the native agent-tool contract", () => {
    interface DelegateProps extends Record<string, unknown> {
      query: string;
    }

    const inputSchema = {
      parse(value: unknown): DelegateProps {
        if (!value || typeof value !== "object" || typeof (value as { query?: unknown }).query !== "string") {
          throw new Error("query is required");
        }
        return value as DelegateProps;
      },
    };
    const outputSchema = {
      parse(value: unknown): { answer: string } {
        if (!value || typeof value !== "object" || typeof (value as { answer?: unknown }).answer !== "string") {
          throw new Error("answer is required");
        }
        return value as { answer: string };
      },
    };

    class DelegateAgent extends Agent<Record<string, never>, DelegateProps> {
      static agentName = "definition-delegate";
      initialState = {};

      render() {
        return this.define({
          model: "test/delegate",
          inputSchema,
          outputSchema,
          prompt: `Delegate ${this.props.query}`,
        });
      }
    }

    const Delegate = compileAgentClass(DelegateAgent);
    const definition = Delegate.spec.resolveDefinition!(
      { query: "schema propagation" },
      createStore({}),
    );

    expect(definition.inputSchema).toBe(inputSchema);
    expect(definition.outputSchema).toBe(outputSchema);
    expect(Delegate.spec.inputSchema).toBe(inputSchema);
    expect(Delegate.spec.outputSchema).toBe(outputSchema);
  });

  it("validates a class boundary's first input using the schema declared by render", () => {
    interface StrictProps extends Record<string, unknown> {
      query: string;
    }
    const strictInput = {
      parse(value: unknown): StrictProps {
        if (!value || typeof value !== "object" || typeof (value as { query?: unknown }).query !== "string") {
          throw new Error("query must be a string");
        }
        return value as StrictProps;
      },
    };
    class StrictAgent extends Agent<Record<string, never>, StrictProps> {
      static agentName = "strict-definition-input";
      initialState = {};
      render() {
        return this.define({
          model: "test/strict",
          inputSchema: strictInput,
          prompt: String(this.props.query),
        });
      }
    }
    const Strict = compileAgentClass(StrictAgent);

    expect(() => Strict({ name: "strict-child", query: 42 as never })).toThrow(
      'boundary "strict-child" (kind strict-definition-input): input does not match inputSchema — query must be a string',
    );
  });

  it("treats tool names called type and props as a tool map, not JSX", () => {
    class NamedToolsAgent extends Agent<Record<string, never>> {
      static agentName = "named-tools";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          tools: {
            type: { description: "Type tool", execute: () => ({ ok: true }) },
            props: { description: "Props tool", execute: () => ({ ok: true }) },
          },
        });
      }
    }
    const NamedTools = compileAgentClass(NamedToolsAgent);
    const definition = NamedTools.spec.resolveDefinition!({}, createStore({}));
    expect(Object.keys(definition.tools)).toEqual(["type", "props"]);
  });

  it("does not evaluate render with fake empty props during compilation", () => {
    expect(() => compileAgentClass(ResearchAgent)).not.toThrow();
  });

  it("rejects UI and async render results", async () => {
    class UiAgent extends Agent<Record<string, never>> {
      static agentName = "ui-agent";
      initialState = {};
      render() {
        return <div>not an agent definition</div> as never;
      }
    }
    class AsyncAgent extends Agent<Record<string, never>> {
      static agentName = "async-agent";
      initialState = {};
      // @ts-expect-error intentional invalid fixture: render must be synchronous.
      async render() {
        return this.define({ model: "test/model" });
      }
    }

    const UI = compileAgentClass(UiAgent);
    const Async = compileAgentClass(AsyncAgent);
    expect(() => UI.spec.resolveDefinition!({}, createStore({}))).toThrow(
      '[agent-jsx] agent "ui-agent": render() must return this.define({...}); UI elements are not agent definitions',
    );
    expect(() => (Async.spec.resolveDefinition as any)({}, createStore({}))).toThrow(
      '[agent-jsx] agent "async-agent": render() returned a Promise; agent definitions must be synchronous',
    );
  });

  it("rejects an empty model and metadata that changes between renders", () => {
    class EmptyModelAgent extends Agent<Record<string, never>> {
      static agentName = "empty-model";
      initialState = {};
      render() {
        return this.define({ model: " " });
      }
    }
    class DynamicModelAgent extends Agent<{ alternate: boolean }> {
      static agentName = "dynamic-model";
      initialState = { alternate: false };
      render() {
        return this.define({ model: this.state.alternate ? "test/b" : "test/a" });
      }
    }

    const Empty = compileAgentClass(EmptyModelAgent);
    const Dynamic = compileAgentClass(DynamicModelAgent);
    expect(() => Empty.spec.resolveDefinition!({}, createStore({}))).toThrow(
      '[agent-jsx] agent "empty-model": definition.model must contain a non-empty model id',
    );
    Dynamic.spec.resolveDefinition!({}, createStore<{ alternate: boolean }>({ alternate: false }));
    expect(() => Dynamic.spec.resolveDefinition!({}, createStore<{ alternate: boolean }>({ alternate: true }))).toThrow(
      '[agent-jsx] agent "dynamic-model": static definition field "model" changed between renders',
    );
  });

  it("reports a contract error for a non-string model", () => {
    class InvalidModelAgent extends Agent<Record<string, never>> {
      static agentName = "invalid-model";
      initialState = {};
      render() {
        return this.define({ model: 42 as never });
      }
    }
    const Invalid = compileAgentClass(InvalidModelAgent);
    expect(() => Invalid.spec.resolveDefinition!({}, createStore({}))).toThrow(
      '[agent-jsx] agent "invalid-model": definition.model must contain a non-empty model id',
    );
  });

  it("rejects MCP names that collide after Cloudflare stable-id normalization", () => {
    class CollisionAgent extends Agent<Record<string, never>> {
      static agentName = "mcp-collision";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          mcpServers: {
            "GitHub MCP!": { url: "https://mcp.example.com/one" },
            "github-mcp": { url: "https://mcp.example.com/two" },
          },
        });
      }
    }
    const Collision = compileAgentClass(CollisionAgent);
    expect(() => Collision.spec.resolveDefinition!({}, createStore({}))).toThrow(
      /normalize to the same Cloudflare server id "github-mcp"/,
    );
  });

  it("keeps deployment credentials out of authored MCP descriptors", () => {
    class HeaderCredentialAgent extends Agent<Record<string, never>> {
      static agentName = "mcp-header-credential";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          mcpServers: {
            docs: {
              url: "https://mcp.example.com/docs",
              headers: { authorization: "Bearer secret" },
            } as never,
          },
        });
      }
    }
    class UrlCredentialAgent extends Agent<Record<string, never>> {
      static agentName = "mcp-url-credential";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          mcpServers: {
            docs: { url: "https://user:secret@mcp.example.com/docs" },
          },
        });
      }
    }
    class FragmentAgent extends Agent<Record<string, never>> {
      static agentName = "mcp-url-fragment";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          mcpServers: {
            docs: { url: "https://mcp.example.com/docs#configuration" },
          },
        });
      }
    }

    const HeaderCredential = compileAgentClass(HeaderCredentialAgent);
    const UrlCredential = compileAgentClass(UrlCredentialAgent);
    const Fragment = compileAgentClass(FragmentAgent);
    expect(() => HeaderCredential.spec.resolveDefinition!({}, createStore({}))).toThrow(
      /mcpServers\.docs\.headers is not portable/,
    );
    expect(() => UrlCredential.spec.resolveDefinition!({}, createStore({}))).toThrow(
      /must not contain credentials/,
    );
    expect(() => Fragment.spec.resolveDefinition!({}, createStore({}))).toThrow(
      /url must not contain a fragment/,
    );

    const credentialQueryKeys = [
      "token",
      "access-token",
      "apiKey",
      "Authorization",
      "client_secret",
      "password",
      "webhookSecret",
      "X-Amz-Signature",
    ];
    for (const key of credentialQueryKeys) {
      const secretValue = `must-not-leak-${key}`;
      class QueryCredentialAgent extends Agent<Record<string, never>> {
        static agentName = "mcp-query-credential";
        initialState = {};
        render() {
          const url = new URL("https://mcp.example.com/docs");
          url.searchParams.set(key, secretValue);
          return this.define({
            model: "test/model",
            mcpServers: { docs: { url: url.toString() } },
          });
        }
      }
      const QueryCredential = compileAgentClass(QueryCredentialAgent);
      let message = "";
      try {
        QueryCredential.spec.resolveDefinition!({}, createStore({}));
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("sensitive MCP credential query parameter");
      expect(message).not.toContain(secretValue);
    }
  });

  it("rejects UI host elements hidden inside the prompt declaration", () => {
    class PromptUiAgent extends Agent<Record<string, never>> {
      static agentName = "prompt-ui";
      initialState = {};
      render() {
        return this.define({ model: "test/model", prompt: <div>not prompt JSX</div> });
      }
    }
    const PromptUI = compileAgentClass(PromptUiAgent);
    const roots = evaluateComponent(PromptUI.spec.impl, {
      store: createStore({}),
      emit: () => {},
    });
    expect(() => collectPrompt(roots)).toThrow(
      '[agent-jsx] agent definition.prompt may contain only prompt JSX and text; found <div>',
    );
  });

  it("rejects infrastructure in prompt JSX before it can be collected", () => {
    class PromptInfraAgent extends Agent<Record<string, never>> {
      static agentName = "prompt-infra";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          prompt: (
            <prompt>
              <sys>Never install infrastructure from the prompt.</sys>
              <tool
                name="prompt-tool"
                description="Must remain inert."
                run={() => ({ compromised: true })}
              />
            </prompt>
          ),
        });
      }
    }
    const PromptInfra = compileAgentClass(PromptInfraAgent);
    const roots = evaluateComponent(PromptInfra.spec.impl, {
      store: createStore({}),
      emit: () => {},
    });
    const records: ReturnType<typeof collectInfra> = [];

    expect(() => {
      for (const root of roots) collectInfra(root, records);
    }).toThrow(
      '[agent-jsx] agent definition.prompt may contain only prompt JSX and text; found <tool>',
    );
    expect(records).toEqual([]);
    expect(() => collectPrompt(roots)).toThrow(
      '[agent-jsx] agent definition.prompt may contain only prompt JSX and text; found <tool>',
    );
  });

  it("allows tool components and fragments when they resolve only to tool leaves", () => {
    function ToolGroup() {
      return (
        <>
          <tool name="lookup" description="Lookup." run={() => ({ ok: true })} />
          <tool name="summarize" description="Summarize." run={() => ({ ok: true })} />
        </>
      );
    }
    class ToolGroupAgent extends Agent<Record<string, never>> {
      static agentName = "tool-group";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          prompt: "Keep tools out of the prompt.",
          tools: <ToolGroup />,
        });
      }
    }
    const ToolGroupDefinition = compileAgentClass(ToolGroupAgent);
    const roots = evaluateComponent(ToolGroupDefinition.spec.impl, {
      store: createStore({}),
      emit: () => {},
    });

    expect(collectPrompt(roots).map((block) => block.text)).toEqual([
      "Keep tools out of the prompt.",
    ]);
    expect(
      roots.flatMap((root) => collectInfra(root)).map((record) => record.name),
    ).toEqual(["lookup", "summarize"]);
  });

  it("rejects prompt and hierarchy nodes produced by definition.tools components", () => {
    function InvalidToolGroup() {
      return (
        <>
          <prompt><sys>Injected tool-zone prompt.</sys></prompt>
          <schedule name="tool-zone-schedule" every={1} onFire={() => {}} />
        </>
      );
    }
    class InvalidToolGroupAgent extends Agent<Record<string, never>> {
      static agentName = "invalid-tool-group";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          prompt: "Only this prompt is authoritative.",
          tools: <InvalidToolGroup />,
        });
      }
    }
    const InvalidToolGroupDefinition = compileAgentClass(InvalidToolGroupAgent);
    const roots = evaluateComponent(InvalidToolGroupDefinition.spec.impl, {
      store: createStore({}),
      emit: () => {},
    });
    const records: ReturnType<typeof collectInfra> = [];

    expect(() => collectPrompt(roots)).toThrow(
      '[agent-jsx] agent definition.tools may contain only declarative <tool> nodes; found <prompt>',
    );
    expect(() => {
      for (const root of roots) collectInfra(root, records);
    }).toThrow(
      '[agent-jsx] agent definition.tools may contain only declarative <tool> nodes; found <prompt>',
    );
    expect(records).toEqual([]);
  });

  it("preserves own __proto__ entries in tool and MCP records", () => {
    const protoTool = { description: "Prototype-safe tool", execute: () => ({ ok: true }) };
    const tools = Object.fromEntries([["__proto__", protoTool]]) as AgentToolSet;
    const mcpServers = Object.fromEntries([
      ["__proto__", { url: "https://mcp.example.com/prototype" }],
    ]) as McpServerDefinitions;
    class PrototypeKeysAgent extends Agent<Record<string, never>> {
      static agentName = "prototype-keys";
      initialState = {};
      render() {
        return this.define({ model: "test/model", tools, mcpServers });
      }
    }
    const PrototypeKeys = compileAgentClass(PrototypeKeysAgent);
    const definition = PrototypeKeys.spec.resolveDefinition!({}, createStore({}));

    expect(Object.hasOwn(definition.tools, "__proto__")).toBe(true);
    expect(definition.tools.__proto__).toBe(protoTool);
    expect(Object.hasOwn(definition.mcpServers, "__proto__")).toBe(true);
    expect(definition.mcpServers.__proto__).toEqual({
      url: "https://mcp.example.com/prototype",
    });
  });

  it("collects prompt blocks while ignoring adjacent declarative tool infra", () => {
    class PromptAndToolAgent extends Agent<Record<string, never>> {
      static agentName = "prompt-and-tool";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          prompt: "Keep the authored prompt.",
          tools: (
            <tool
              name="lookup"
              description="Lookup one value."
              run={() => ({ ok: true })}
            />
          ),
        });
      }
    }
    const PromptAndTool = compileAgentClass(PromptAndToolAgent);
    const roots = evaluateComponent(PromptAndTool.spec.impl, {
      store: createStore({}),
      emit: () => {},
    });

    expect(collectPrompt(roots).map((block) => block.text)).toEqual([
      "Keep the authored prompt.",
    ]);
    expect(
      roots.flatMap((root) => collectInfra(root)).some((record) => record.name === "lookup"),
    ).toBe(true);
  });
});

describe("render definition target adapters", () => {
  const analysis = analyzeAgent({
    spec: Research.spec,
    exportName: "Research",
    importPath: "./research.tsx",
    samples: [{ props: sampleProps, state: Research.spec.initialState }],
  });

  it("lowers skills and MCP lifecycle to Cloudflare Think without connecting at emit time", () => {
    const { agents } = emitThink(
      { spec: Research.spec, componentName: "Research", componentImport: "./research.tsx" },
      [],
      analysis,
      {
        runtimeImport: "./runtime",
        mcpConnectionTimeoutMs: 2_500,
        mcpResolver: {
          importPath: "./mcp-runtime.ts",
          exportName: "resolveMcpServer",
        },
      },
    );

    expect(agents).toContain("override getSkills()");
    expect(agents).toContain("waitForMcpConnections = { timeout: 2500 };");
    expect(agents).toContain('import { resolveMcpServer } from "./mcp-runtime.ts";');
    expect(agents).toContain("override async onStart()");
    expect(agents).not.toContain("ChatStartEvent");
    expect(agents).toContain("this.getMcpServers().servers");
    expect(agents).toContain("await this.removeMcpServer(id)");
    expect(agents).toContain('await resolveMcpServer(this.env, "docs",');
    expect(agents).toContain("await this.addMcpServer(");
    expect(agents).toContain('"callbackPath", "configRevision"');
    expect(agents).toContain('if ("headers" in runtime)');
    expect(agents).toContain("Cloudflare Agents persists MCP transport headers");
    expect(agents).toContain("url.username || url.password");
    expect(agents).toContain("sensitive MCP credential query parameter");
    expect(agents).toContain("compact.includes(part)");
    expect(agents).toContain('compact.endsWith("auth")');
    expect(agents).toContain("callbackHost must be an HTTP(S) origin without credentials");
    expect(agents).toContain("callbackPath must be an absolute plain path");
    expect(agents).toContain("unsupported mcpResolver field");
    expect(agents).toContain("CREATE TABLE IF NOT EXISTS agent_jsx_mcp_config");
    expect(agents).toContain("config_key TEXT NOT NULL");
    expect(agents).toContain("recordedKey !== next.configKey");
    expect(agents).toContain("server.configKey");
    expect(agents).not.toContain("headers?: HeadersInit");
    expect(agents).not.toContain("server.headers");
  });

  it("rejects invalid aggregate MCP wait timeouts", () => {
    expect(() =>
      emitThink(
        { spec: Research.spec, componentName: "Research", componentImport: "./research.tsx" },
        [],
        analysis,
        { mcpConnectionTimeoutMs: 0 },
      ),
    ).toThrow("[agent-jsx] mcpConnectionTimeoutMs must be a positive number");
  });

  it("removes previously compiler-managed MCP servers after a definition deletes them", () => {
    class NoMcpAgent extends Agent<Record<string, never>> {
      static agentName = "no-mcp-now";
      initialState = {};
      render() {
        return this.define({ model: "test/model" });
      }
    }
    const NoMcp = compileAgentClass(NoMcpAgent);
    const noMcpAnalysis = analyzeAgent({
      spec: NoMcp.spec,
      exportName: "NoMcp",
      importPath: "./no-mcp.tsx",
    });
    const { agents } = emitThink(
      { spec: NoMcp.spec, componentName: "NoMcp", componentImport: "./no-mcp.tsx" },
      [],
      noMcpAnalysis,
      { runtimeImport: "./runtime" },
    );

    expect(agents).toContain("CREATE TABLE IF NOT EXISTS agent_jsx_mcp_config");
    expect(agents).toContain("const desired: DesiredMcpServer[] = [];");
    expect(agents).toContain("(!next && recordedKey !== undefined)");
    expect(agents).not.toContain("waitForMcpConnections = true");
  });

  it("keeps the compiler-owned MCP cleanup lifecycle after a low-level spec deletes its final server", () => {
    const LegacyNoMcp = agentComponent({
      agentName: "legacy-no-mcp-now",
      initialState: {},
      impl: () => <prompt><sys>No MCP servers remain.</sys></prompt>,
    });
    const legacyAnalysis = analyzeAgent({
      spec: LegacyNoMcp.spec,
      exportName: "LegacyNoMcp",
      importPath: "./legacy-no-mcp.tsx",
    });
    const { agents } = emitThink(
      {
        spec: LegacyNoMcp.spec,
        componentName: "LegacyNoMcp",
        componentImport: "./legacy-no-mcp.tsx",
      },
      [],
      legacyAnalysis,
      { runtimeImport: "./runtime" },
    );

    expect(agents).toContain("export class LegacyNoMcpNowDurable");
    expect(agents).toContain("CREATE TABLE IF NOT EXISTS agent_jsx_mcp_config");
    expect(agents).toContain("const desired: DesiredMcpServer[] = [];");
    expect(agents).toContain("(!next && recordedKey !== undefined)");
  });

  it("emits dynamic, schema-preserving tool maps instead of compile-time flattened tools", () => {
    class ToggleToolsAgent extends Agent<{ enabled: boolean }> {
      static agentName = "toggle-tools";
      initialState = { enabled: false };
      render() {
        return this.define({
          model: "test/model",
          tools: this.state.enabled
            ? {
                structured: {
                  description: "Structured output",
                  inputSchema: searchInputSchema,
                  execute: () => ({ ok: true }),
                },
              }
            : {},
        });
      }
    }
    const ToggleTools = compileAgentClass(ToggleToolsAgent);
    const toggleAnalysis = analyzeAgent({
      spec: ToggleTools.spec,
      exportName: "ToggleTools",
      importPath: "./toggle-tools.tsx",
    });
    const { agents } = emitThink(
      { spec: ToggleTools.spec, componentName: "ToggleTools", componentImport: "./toggle-tools.tsx" },
      [],
      toggleAnalysis,
      { runtimeImport: "./runtime" },
    );

    expect(agents).toContain("this.renderedDefinition().tools");
    expect(agents).toContain("this.localDefinitionTools(),");
    expect(agents).not.toContain('this.toolByName("structured"');
  });

  it("keeps model-only definitions inert and explicit in reconcile mode", () => {
    const out = emitCloudflare(
      { spec: Research.spec, componentName: "Research", componentImport: "./research.tsx" },
      [],
      analysis,
      { runtimeImport: "./runtime" },
    ).agents;

    expect(out).toContain("cloudflare-reconcile-definition-inert");
    expect(out).not.toContain("addMcpServer(");
    expect(out).not.toContain("getSkills()");
  });

});
