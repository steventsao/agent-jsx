/**
 * THINK MODE — model-driven delegation as a first-class compile target.
 *
 * Steven's direction: compiling to `agentTool` + `@cloudflare/think` is a real
 * MODE, not a gated bolt-on. `emitThink` generates `class X extends Think<Env>`
 * where:
 *   - getSystemPrompt() = the component's <prompt> rendered over state;
 *   - getTools() = the component's static <tool> records (→ AI-SDK `tool`) PLUS
 *     every child boundary as `agentTool(ChildDurable, { description, inputSchema })`
 *     — slot-bound children NAMED BY THE PROP KEY, plain children NAMED BY KIND;
 *   - children are their own Think subclasses (spawned per tool-call as facets).
 *
 * Contract under test (emitted-string level; compat/think proves it on real
 * workerd against @cloudflare/think@0.12.1 + agents@0.17.3):
 *   - the slot binding onCall → agentTool(ToolWorkerDurable, …) (prop-key name);
 *   - a plain nested child → agentTool named by KIND;
 *   - a static <tool> → getTools()[name] = tool(...) via the base toolByName;
 *   - sensors/schedules/tasks are think-UNSUPPORTED → loud target diagnostics;
 *   - getModel() is NOT emitted (inherits Think's throwing default; the consumer
 *     overrides it) — the class still boots.
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
    graph.slice(1).map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath })),
    graph[0]!.analysis,
    { runtimeImport: "./runtime" }
  );
};

describe("emitThink — shared Think base + system prompt", () => {
  it("extends @cloudflare/think and renders getSystemPrompt from the component", () => {
    const { agents } = coordinatorThink();
    expect(agents).toContain('import { Think } from "@cloudflare/think";');
    expect(agents).toContain("abstract class ThinkAgentBase<S extends Record<string, unknown>> extends Think<GeneratedEnv> {");
    expect(agents).toContain("override getSystemPrompt(): string {");
    expect(agents).toContain("renderPromptOrFallback(");
    // Each agent is its own Think subclass (spawnable as a facet).
    expect(agents).toContain("export class CoordinatorDurable extends ThinkAgentBase<");
    expect(agents).toContain("export class ToolWorkerDurable extends ThinkAgentBase<");
  });

  it("does NOT emit a getModel method — the class inherits Think's throwing default (consumer overrides)", () => {
    const { agents } = coordinatorThink();
    // No method definition, no LanguageModel import (a comment may still name it).
    expect(agents).not.toContain("getModel(): LanguageModel");
    expect(agents).not.toContain("import type { LanguageModel");
    expect(agents).not.toContain("getModel() {");
  });
});

describe("emitThink — child boundaries become agentTools", () => {
  it("slot binding → agentTool NAMED BY THE PROP KEY, schema'd by the child spec", () => {
    const { agents } = coordinatorThink();
    expect(agents).toContain('import { agentTool } from "agents/agent-tools";');
    expect(agents).toContain("override getTools(): ToolSet {");
    expect(agents).toContain(
      "onCall: agentTool(ToolWorkerDurable, { description: Worker.spec.description, inputSchema: Worker.spec.inputSchema }),"
    );
  });

  it("a leaf child emits no getTools override and no AI tool import (zero-churn)", () => {
    const { agents } = coordinatorThink();
    // Worker is a leaf with a <task> (not a <tool>) → no static tools anywhere.
    expect(agents).not.toContain("jsonSchema");
    expect(agents).not.toContain("this.toolByName(");
  });

  it("a PLAIN nested child → agentTool NAMED BY KIND", () => {
    const { agents } = notetakerThink();
    expect(agents).toContain(
      "researcher: agentTool(ResearcherDurable, { description: Researcher.spec.description, inputSchema: Researcher.spec.inputSchema }),"
    );
    expect(agents).toContain("export class ResearcherDurable extends ThinkAgentBase<");
  });
});

describe("emitThink — static <tool> records become AI-SDK tools", () => {
  it("emits getTools()[name] = tool(...) via the base toolByName, importing tool + jsonSchema", () => {
    const { agents } = notetakerThink();
    expect(agents).toContain('import { tool, jsonSchema } from "ai";');
    expect(agents).toContain("protected toolByName(");
    expect(agents).toContain('saveNote: this.toolByName("saveNote", "Save a note to the notebook."),');
  });

  it("the same getTools carries BOTH the static tool and the child agentTool", () => {
    const { agents } = notetakerThink();
    const block = agents.slice(agents.indexOf("class NotetakerDurable"));
    expect(block).toContain('saveNote: this.toolByName("saveNote", "Save a note to the notebook."),');
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
      graph.slice(1).map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath })),
      graph[0]!.analysis,
      { runtimeImport: "./runtime" }
    );
    expect(agents).toContain("TARGET WARNING [think-sensor-unsupported]");
  });
});
