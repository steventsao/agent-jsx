/**
 * THINK MODE — model-driven delegation as a first-class compile target.
 *
 * Steven's direction: compiling to `agentTool` + `@cloudflare/think` is a real
 * MODE, not a gated bolt-on. `emitThink` generates `class X extends Think<Env>`
 * where:
 *   - getSystemPrompt() = the component's <prompt> rendered over state;
 *   - getTools() = live AI SDK/declarative tools PLUS every child boundary as
 *     `agentTool(ChildDurable, { description, inputSchema })`
 *     — slot-bound children NAMED BY THE PROP KEY, plain children NAMED BY KIND;
 *   - children are their own Think subclasses (spawned per tool-call as facets).
 *
 * Contract under test (emitted-string level; compat/think proves it on real
 * workerd against the current @cloudflare/think + agents compatibility pins):
 *   - the slot binding onCall → agentTool(ToolWorkerDurable, …) (prop-key name);
 *   - a plain nested child → agentTool named by KIND;
 *   - a declarative <tool> is rebuilt from the current rendered definition;
 *   - sensors/schedules/tasks are think-UNSUPPORTED → loud target diagnostics;
 *   - an explicit class model becomes getModel(); a legacy spec without one
 *     still inherits Think's throwing default and boots for tests/overrides;
 *   - runTurnWithTrace binds per-turn props and collects public reasoning parts.
 */

import { describe, expect, it } from "bun:test";
import { emitThink } from "../src/compile/emit-think.ts";
import { thinkTargetDiagnostics } from "../src/compile/target-diagnostics.ts";
import { analyzeAgent, discoverAgents } from "../src/compile/graph.ts";
import { discoverToolSlots } from "../src/compile/slots.ts";
import { Coordinator } from "../examples/tool-slot/coordinator.tsx";
import { Worker } from "../examples/tool-slot/worker.tsx";
import { Notetaker } from "../examples/think/notetaker.tsx";
import { Researcher } from "../examples/think/researcher.tsx";
import { UptimeAgent } from "../examples/uptime-agent.tsx";
import { Investigator } from "../examples/investigator.tsx";
import { Agent, compileAgentClass } from "../src/agent-class.tsx";
import { agentComponent } from "../src/agent-component.tsx";
import type { AgentSkillSource } from "../src/types.ts";

const withWorker = () => (
  <Coordinator name="coord">{(handleCall) => <Worker name="w" onCall={handleCall} />}</Coordinator>
);

const coordinatorThink = () =>
  emitThink(
    { spec: Coordinator.spec, componentName: "Coordinator", componentImport: "./coordinator.tsx" },
    [{ spec: Worker.spec, exportName: "Worker", importPath: "./worker.tsx" }],
    analyzeAgent({ spec: Coordinator.spec, exportName: "Coordinator", importPath: "./coordinator.tsx" }),
    { runtimeImport: "./runtime", toolSlots: discoverToolSlots(withWorker()) }
  );

const notetakerGraph = () =>
  discoverAgents(
    { spec: Notetaker.spec, exportName: "Notetaker", importPath: "./notetaker.tsx" },
    [{ spec: Researcher.spec, exportName: "Researcher", importPath: "./researcher.tsx" }]
  );
const notetakerThink = () => {
  const graph = notetakerGraph();
  return emitThink(
    { spec: graph[0]!.spec, componentName: "Notetaker", componentImport: "./notetaker.tsx" },
    graph.slice(1).map((n) => ({
      spec: n.spec,
      exportName: n.exportName,
      importPath: n.importPath,
      analysis: n.analysis,
    })),
    graph[0]!.analysis,
    { runtimeImport: "./runtime" }
  );
};

const definitionChildInputSchema = {
  parse(value: unknown) {
    return value as { query: string };
  },
};
const definitionChildOutputSchema = {
  parse(value: unknown) {
    return value as { answer: string };
  },
};

class DefinitionChildAgent extends Agent<
  Record<string, never>,
  { query: string }
> {
  static agentName = "definition-child";
  initialState = {};

  render() {
    return this.define({
      model: "test/definition-child",
      description: "Handle one delegated query.",
      inputSchema: definitionChildInputSchema,
      outputSchema: definitionChildOutputSchema,
      prompt: <prompt><msg>Delegated query: {this.props.query}</msg></prompt>,
    });
  }
}

const DefinitionChild = compileAgentClass(DefinitionChildAgent);
const DefinitionParent = agentComponent({
  agentName: "definition-parent",
  model: "test/definition-parent",
  initialState: {},
  impl: () => (
    <>
      <prompt><sys>Delegate when useful.</sys></prompt>
      <DefinitionChild name="worker" query="compile-time sample" />
    </>
  ),
});

const definitionAgentToolThink = () =>
  emitThink(
    {
      spec: DefinitionParent.spec,
      componentName: "DefinitionParent",
      componentImport: "./definition-parent.tsx",
    },
    [{
      spec: DefinitionChild.spec,
      exportName: "DefinitionChild",
      importPath: "./definition-child.tsx",
      sampleProps: { query: "compile-time sample" },
    }],
    analyzeAgent({
      spec: DefinitionParent.spec,
      exportName: "DefinitionParent",
      importPath: "./definition-parent.tsx",
    }),
    { runtimeImport: "./runtime" },
  );

describe("emitThink — shared Think base + system prompt", () => {
  it("extends @cloudflare/think and renders getSystemPrompt from the component", () => {
    const { agents } = coordinatorThink();
    expect(agents).toContain('import { Think } from "@cloudflare/think";');
    expect(agents).toContain("abstract class ThinkAgentBase<S extends Record<string, unknown>> extends Think<GeneratedEnv> {");
    expect(agents).toContain("protected authoredPrompt(): string {");
    expect(agents).toContain("override getSystemPrompt(): string { return this.authoredPrompt(); }");
    expect(agents).toContain("renderPromptOrFallback(");
    // Each agent is its own Think subclass (spawnable as a facet).
    expect(agents).toContain("export class CoordinatorDurable extends ThinkAgentBase<");
    expect(agents).toContain("export class ToolWorkerDurable extends ThinkAgentBase<");
  });

  it("composes the current authored prompt with Think's skill catalog per turn", () => {
    const skill = {
      id: "review",
      fingerprint: "review-v1",
      async list() {
        return [{ name: "review", description: "Review evidence." }];
      },
      async load(name: string) {
        return name === "review"
          ? { name, description: "Review evidence.", body: "Check sources." }
          : null;
      },
    } satisfies AgentSkillSource;

    class SkilledAgent extends Agent<{ revision: number }> {
      static agentName = "skilled";
      initialState = { revision: 1 };

      render() {
        return this.define({
          model: "test/skilled",
          prompt: `Authored revision ${this.state.revision}`,
          skills: [skill],
        });
      }
    }

    const Skilled = compileAgentClass(SkilledAgent);
    const { agents } = emitThink(
      { spec: Skilled.spec, componentName: "Skilled", componentImport: "./skilled.tsx" },
      [],
      analyzeAgent({ spec: Skilled.spec, exportName: "Skilled", importPath: "./skilled.tsx" }),
      { runtimeImport: "./runtime" },
    );
    const skilledClass = agents.slice(agents.indexOf("export class SkilledDurable"));

    expect(agents).toContain('import type { TurnContext } from "@cloudflare/think";');
    expect(skilledClass).toContain("override async beforeTurn(ctx: TurnContext)");
    expect(skilledClass).toContain("const assembledPrompt = ctx.system.trim()");
    expect(skilledClass).not.toContain("freezeSystemPrompt()");
    expect(skilledClass).toContain("instructions:");
    expect(skilledClass).not.toContain("override getSystemPrompt(): string");
  });

  it("leaves getModel ungenerated when a low-level spec has no authored model", () => {
    const { agents } = coordinatorThink();
    // No method definition, no LanguageModel import (a comment may still name it).
    expect(agents).not.toContain("getModel(): LanguageModel");
    expect(agents).not.toContain("import type { LanguageModel");
    expect(agents).not.toContain("getModel() {");
  });

  it("emits an explicitly authored class model and a traced programmatic-turn bridge", () => {
    class ModeledAgent extends Agent<{ turns: number }, { topic: string }> {
      static agentName = "modeled";
      initialState = { turns: 0 };

      render() {
        return this.define({
          model: "openrouter/openai/gpt-5-mini",
          prompt: `Discuss ${this.props.topic}.`,
        });
      }
    }

    const Modeled = compileAgentClass(ModeledAgent);
    const analysis = analyzeAgent({
      spec: Modeled.spec,
      exportName: "Modeled",
      importPath: "./modeled.tsx",
      samples: [{ props: { topic: "compilers" }, state: Modeled.spec.initialState }],
    });
    const { agents, wrangler } = emitThink(
      { spec: Modeled.spec, componentName: "Modeled", componentImport: "./modeled.tsx" },
      [],
      analysis,
      { runtimeImport: "./runtime" },
    );

    expect(agents).toContain('override getModel() { return Modeled.spec.model ?? "openrouter/openai/gpt-5-mini"; }');
    expect(agents).toContain("async runTurnWithTrace(input: string, props?: Record<string, unknown>)");
    expect(agents).toContain("const turnToken = {};");
    expect(agents).toContain("await this.chat(() => {");
    expect(agents).toContain("this.#activeTurn = { token: turnToken, props };");
    expect(agents).toContain('case "reasoning-delta"');
    expect(agents).toContain("this.turnProps(MODELED_PROPS)");
    expect(wrangler).toContain('"ai": { "binding": "AI" }');
  });

  it("can delegate explicit model strings to deployment-owned provider glue", () => {
    class ModeledAgent extends Agent<{ turns: number }> {
      static agentName = "modeled-adapter";
      initialState = { turns: 0 };

      render() {
        return this.define({ model: "openrouter/openai/gpt-5-mini" });
      }
    }

    const Modeled = compileAgentClass(ModeledAgent);
    const analysis = analyzeAgent({
      spec: Modeled.spec,
      exportName: "Modeled",
      importPath: "./modeled.tsx",
    });
    const { agents } = emitThink(
      { spec: Modeled.spec, componentName: "Modeled", componentImport: "./modeled.tsx" },
      [],
      analysis,
      {
        runtimeImport: "./runtime",
        modelResolver: {
          importPath: "./model-runtime.ts",
          exportName: "resolveDeploymentModel",
        },
      },
    );

    expect(agents).toContain(
      'import { resolveDeploymentModel } from "./model-runtime.ts";',
    );
    expect(agents).toContain(
      'override getModel() { return resolveDeploymentModel(this.env, Modeled.spec.model ?? "openrouter/openai/gpt-5-mini"); }',
    );
    expect(agents).not.toContain('if (model.startsWith("openrouter/"))');
  });
});

describe("emitThink — child boundaries become agentTools", () => {
  it("slot binding → agentTool NAMED BY THE PROP KEY, schema'd by the child spec", () => {
    const { agents } = coordinatorThink();
    expect(agents).toContain('import { agentTool } from "agents/agent-tools";');
    expect(agents).toContain("override getTools(): ToolSet {");
    expect(agents).toContain(
      "onCall: agentTool(ToolWorkerDurable, { description: Worker.spec.description ?? \"onCall\", displayName: Worker.spec.displayName, inputSchema: modelToolInputSchema(Worker.spec.inputSchema), outputSchema: Worker.spec.outputSchema }),"
    );
  });

  it("emits prototype-key child tools as own data properties", () => {
    const { agents } = emitThink(
      {
        spec: Coordinator.spec,
        componentName: "Coordinator",
        componentImport: "./coordinator.tsx",
      },
      [{ spec: Worker.spec, exportName: "Worker", importPath: "./worker.tsx" }],
      analyzeAgent({
        spec: Coordinator.spec,
        exportName: "Coordinator",
        importPath: "./coordinator.tsx",
      }),
      {
        runtimeImport: "./runtime",
        toolSlots: [{
          toolName: "__proto__",
          childKind: Worker.spec.agentName,
          provider: Coordinator.spec.agentName,
          stableId: "prototype-safe-worker",
        }],
      },
    );

    expect(agents).toContain('["__proto__"]: agentTool(ToolWorkerDurable');
    expect(agents).not.toMatch(/\n\s+__proto__: agentTool/);
  });

  it("a leaf child emits no getTools override", () => {
    const { agents } = coordinatorThink();
    const workerClass = agents.slice(agents.indexOf("export class ToolWorkerDurable"));
    expect(workerClass).not.toContain("override getTools(): ToolSet");
  });

  it("a PLAIN nested child → agentTool NAMED BY KIND", () => {
    const { agents } = notetakerThink();
    expect(agents).toContain(
      "researcher: agentTool(ResearcherDurable, { description: Researcher.spec.description ?? \"researcher\", displayName: Researcher.spec.displayName, inputSchema: modelToolInputSchema(Researcher.spec.inputSchema), outputSchema: Researcher.spec.outputSchema }),"
    );
    expect(agents).toContain("export class ResearcherDurable extends ThinkAgentBase<");
  });

  it("JSON-decodes native structured output and validates it exactly once at the parent tool", () => {
    const { agents } = coordinatorThink();
    expect(agents).toContain("protected override getAgentToolOutput(runId: string): unknown");
    expect(agents).toContain("try { return JSON.parse(text); }");
    expect(agents).not.toContain("Worker.spec.outputSchema?.parse(value)");
  });

  it("adapts the public parse-only boundary schema contract for AI SDK tools", () => {
    const { agents } = definitionAgentToolThink();

    expect(agents).toContain("function modelToolInputSchema(schema: unknown): unknown");
    expect(agents).toContain('Symbol.for("vercel.ai.schema")');
    expect(agents).toContain('"~standard" in candidate');
    expect(agents).toContain("parse.call(schema, value)");
    expect(agents).toContain(
      "inputSchema: modelToolInputSchema(DEFINITION_CHILD_DEFINITION.inputSchema)",
    );
  });

  it("initializes class schemas before registering agentTool and maps native input to rendered props", () => {
    const { agents } = definitionAgentToolThink();

    expect(agents).toContain(
      "const DEFINITION_CHILD_DEFINITION = DefinitionChild.spec.resolveDefinition!(DEFINITION_CHILD_PROPS as never, createStore(DefinitionChild.spec.initialState));",
    );
    expect(agents).toContain(
      "definition_child: agentTool(DefinitionChildDurable, { description: DEFINITION_CHILD_DEFINITION.description ?? \"Handle one delegated query.\", displayName: DEFINITION_CHILD_DEFINITION.displayName, inputSchema: modelToolInputSchema(DEFINITION_CHILD_DEFINITION.inputSchema), outputSchema: DEFINITION_CHILD_DEFINITION.outputSchema }),",
    );
    expect(agents).toContain("protected override formatAgentToolInput(input: unknown)");
    expect(agents).toContain("__agentToolProps: props");
    expect(agents).toContain("...(this.#agentToolProps ?? {})");
    expect(agents).toContain("...(this.#activeTurn?.props ?? {})");
  });
});

describe("emitThink — rendered <tool> records become AI-SDK tools", () => {
  it("builds tools from the live render, importing tool + jsonSchema", () => {
    const { agents } = notetakerThink();
    expect(agents).toContain('import { tool, jsonSchema } from "ai";');
    expect(agents).toContain("protected declarativeTool(record: InfraRecord)");
    expect(agents).toContain("inputSchema: modelToolInputSchema(");
    expect(agents).toContain("this.toolRecords().map((record)");
    expect(agents).toContain("const fresh = this.toolRecords().find");
    expect(agents).toContain("const names = new Set<string>();");
    expect(agents).toContain("return Object.fromEntries(entries);");
  });

  it("the same getTools merges live local tools and the child agentTool", () => {
    const { agents } = notetakerThink();
    const block = agents.slice(agents.indexOf("class NotetakerDurable"));
    expect(block).toContain("this.declarativeTools(),");
    expect(block).toContain("researcher: agentTool(ResearcherDurable,");
  });
});

describe("emitThink — wrangler bindings + migration", () => {
  it("binds every generated Think class as a DO with a sqlite migration", () => {
    const { wrangler } = coordinatorThink();
    expect(wrangler).toContain('{ "name": "COORDINATOR", "class_name": "CoordinatorDurable" }');
    expect(wrangler).toContain('{ "name": "TOOL_WORKER", "class_name": "ToolWorkerDurable" }');
    expect(wrangler).toContain('"new_sqlite_classes": ["CoordinatorDurable", "ToolWorkerDurable"]');
  });
});

describe("think target diagnostics — sensors/schedules/tasks are unsupported", () => {
  it("flags <sensor> and <schedule> on a reconcile-shaped component", () => {
    const diags = thinkTargetDiagnostics(UptimeAgent.spec);
    expect(diags.some((d) => d.code === "think-sensor-unsupported")).toBe(true);
    expect(diags.some((d) => d.code === "think-schedule-unsupported")).toBe(true);
    expect(diags.every((d) => d.target === "think" && d.severity === "warning")).toBe(true);
  });

  it("flags a <task> boundary", () => {
    const diags = thinkTargetDiagnostics(Worker.spec);
    expect(diags.some((d) => d.code === "think-task-unsupported")).toBe(true);
  });

  it("a pure prompt+tool+child component (Notetaker) has NO unsupported diagnostics", () => {
    expect(thinkTargetDiagnostics(Notetaker.spec)).toEqual([]);
  });

  it("emitThink embeds the diagnostics as loud header comments", () => {
    const graph = discoverAgents(
      { spec: UptimeAgent.spec, exportName: "UptimeAgent", importPath: "./uptime-agent.tsx" },
      [{ spec: Investigator.spec, exportName: "Investigator", importPath: "./investigator.tsx" }]
    );
    const { agents } = emitThink(
      { spec: graph[0]!.spec, componentName: "UptimeAgent", componentImport: "./uptime-agent.tsx" },
      graph.slice(1).map((n) => ({
        spec: n.spec,
        exportName: n.exportName,
        importPath: n.importPath,
        analysis: n.analysis,
      })),
      graph[0]!.analysis,
      { runtimeImport: "./runtime" }
    );
    expect(agents).toContain("TARGET WARNING [think-sensor-unsupported]");
  });

  it("uses analysis samples so state-gated schedule and task records cannot disappear silently", () => {
    const DynamicInfra = agentComponent<Record<string, never>, { enabled: boolean }>({
      agentName: "dynamic-think-infra",
      initialState: { enabled: false },
      impl: ({ store }) => store.get().enabled
        ? (
            <>
              <schedule name="dynamic-schedule" every={60} onFire={() => {}} />
              <task name="dynamic-task" run={() => "done"} />
            </>
          )
        : <prompt><sys>Waiting.</sys></prompt>,
    });
    const dynamicAnalysis = analyzeAgent({
      spec: DynamicInfra.spec,
      exportName: "DynamicInfra",
      importPath: "./dynamic-infra.tsx",
      samples: [
        { state: { enabled: false } },
        { state: { enabled: true } },
      ],
    });
    const emitted = emitThink(
      {
        spec: DynamicInfra.spec,
        componentName: "DynamicInfra",
        componentImport: "./dynamic-infra.tsx",
      },
      [],
      dynamicAnalysis,
      { runtimeImport: "./runtime" },
    );

    expect(emitted.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "think-schedule-unsupported" }),
      expect.objectContaining({ code: "think-task-unsupported" }),
    ]));
    expect(emitted.agents).toContain("dynamic-schedule");
    expect(emitted.agents).toContain("dynamic-task");
  });

  it("uses each child's analysis for state-gated grandchildren and diagnostics", () => {
    const SampledGrandchild = agentComponent({
      agentName: "sampled-grandchild",
      initialState: {},
      impl: () => <prompt><sys>Handle delegated work.</sys></prompt>,
    });
    const SampledChild = agentComponent<{}, { enabled: boolean }>({
      agentName: "sampled-child",
      initialState: { enabled: false },
      impl: ({ store }) => store.get().enabled
        ? (
            <>
              <SampledGrandchild name="sampled-grandchild-instance" />
              <schedule name="sampled-child-schedule" every={60} onFire={() => {}} />
            </>
          )
        : <prompt><sys>Waiting.</sys></prompt>,
    });
    const SampledRoot = agentComponent({
      agentName: "sampled-root",
      initialState: {},
      impl: () => <SampledChild name="sampled-child-instance" />,
    });
    const graph = discoverAgents(
      {
        spec: SampledRoot.spec,
        exportName: "SampledRoot",
        importPath: "./sampled-root.tsx",
      },
      [
        {
          spec: SampledChild.spec,
          exportName: "SampledChild",
          importPath: "./sampled-child.tsx",
          samples: [
            { state: { enabled: false } },
            { state: { enabled: true } },
          ],
        },
        {
          spec: SampledGrandchild.spec,
          exportName: "SampledGrandchild",
          importPath: "./sampled-grandchild.tsx",
        },
      ],
    );
    const emitted = emitThink(
      {
        spec: graph[0]!.spec,
        componentName: graph[0]!.exportName,
        componentImport: graph[0]!.importPath,
      },
      graph.slice(1).map((node) => ({
        spec: node.spec,
        exportName: node.exportName,
        importPath: node.importPath,
        sampleProps: node.samples?.[0]?.props,
        analysis: node.analysis,
      })),
      graph[0]!.analysis,
      { runtimeImport: "./runtime" },
    );
    const childBlock = emitted.agents.slice(
      emitted.agents.indexOf("export class SampledChildDurable"),
      emitted.agents.indexOf("export class SampledGrandchildDurable"),
    );

    expect(childBlock).toContain(
      "sampled_grandchild: agentTool(SampledGrandchildDurable",
    );
    expect(emitted.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "think-schedule-unsupported" }),
    ]));
    expect(emitted.agents).toContain("sampled-child-schedule");
  });

  it("reports result-bound callables even when the boundary is state-gated", () => {
    const ResultChild = agentComponent<
      { onResult: (value: string) => void },
      Record<string, never>
    >({
      agentName: "result-child",
      initialState: {},
      capabilities: { onResult: { kind: "result" } },
      impl: () => <prompt><sys>Return one result.</sys></prompt>,
    });
    const ResultParent = agentComponent<Record<string, never>, { enabled: boolean }>({
      agentName: "result-parent",
      initialState: { enabled: false },
      impl: ({ store }) => store.get().enabled
        ? <ResultChild name="dynamic-result" onResult={() => {}} />
        : <prompt><sys>Waiting.</sys></prompt>,
    });
    const resultAnalysis = analyzeAgent({
      spec: ResultParent.spec,
      exportName: "ResultParent",
      importPath: "./result-parent.tsx",
      samples: [
        { state: { enabled: false } },
        { state: { enabled: true } },
      ],
    });
    const emitted = emitThink(
      {
        spec: ResultParent.spec,
        componentName: "ResultParent",
        componentImport: "./result-parent.tsx",
      },
      [{ spec: ResultChild.spec, exportName: "ResultChild", importPath: "./result-child.tsx" }],
      resultAnalysis,
      { runtimeImport: "./runtime" },
    );

    expect(emitted.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "think-result-binding-unsupported",
        severity: "warning",
      }),
    ]));
    expect(emitted.agents).toContain("TARGET WARNING [think-result-binding-unsupported]");
    expect(emitted.agents).toContain("dynamic-result.onResult");
  });

  it("reports callback, method, and continuation grants dropped by native agentTool", () => {
    const CapabilityChild = agentComponent<
      {
        onEvent: (value: string) => void;
        lookup: (value: string) => Promise<string>;
      },
      Record<string, never>,
      string
    >({
      agentName: "capability-child",
      initialState: {},
      capabilities: {
        onEvent: { kind: "callback" },
        lookup: { kind: "method" },
      },
      sampleOutput: "sample",
      impl: () => <prompt><sys>Use explicitly granted capabilities.</sys></prompt>,
    });
    const CapabilityParent = agentComponent({
      agentName: "capability-parent",
      initialState: {},
      impl: () => (
        <CapabilityChild
          name="granted-child"
          onEvent={() => {}}
          lookup={async (value) => value}
        >
          {(value) => <prompt><msg>{value}</msg></prompt>}
        </CapabilityChild>
      ),
    });
    const capabilityAnalysis = analyzeAgent({
      spec: CapabilityParent.spec,
      exportName: "CapabilityParent",
      importPath: "./capability-parent.tsx",
    });
    const emitted = emitThink(
      {
        spec: CapabilityParent.spec,
        componentName: "CapabilityParent",
        componentImport: "./capability-parent.tsx",
      },
      [{
        spec: CapabilityChild.spec,
        exportName: "CapabilityChild",
        importPath: "./capability-child.tsx",
      }],
      capabilityAnalysis,
      { runtimeImport: "./runtime" },
    );

    expect(emitted.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "think-callback-binding-unsupported" }),
      expect.objectContaining({ code: "think-method-binding-unsupported" }),
      expect.objectContaining({ code: "think-continuation-binding-unsupported" }),
    ]));
    expect(emitted.agents).toContain("granted-child.onEvent");
    expect(emitted.agents).toContain("granted-child.lookup");
    expect(emitted.agents).toContain("granted-child.__emit");
  });
});
