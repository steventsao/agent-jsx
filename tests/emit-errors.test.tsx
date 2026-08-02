/**
 * Emitter NEGATIVE tests — the loud failure paths that guard composition
 * mistakes at compile time:
 *
 *   - emitFlue requires a model from SOMEWHERE (spec.model or options.model);
 *   - a flue tool-slot binding must resolve to a registered child profile
 *     (flue indexes subagents strictly by profile name, so an alias with no
 *     source profile is a hard error, not a silent skip);
 *   - emitThink refuses a child boundary/slot whose kind has no generated
 *     Think class (the agentTool line would reference an undefined class);
 *   - emitCloudflare agentTools mode refuses a tool-slot binding whose child
 *     kind was not passed as a child (same class-reference hazard);
 *   - emitAgentModule validates the generated export name is a real JS
 *     identifier (the golden happy paths live in agent-source.test.tsx).
 *
 * Every assertion matches the REAL thrown message text from src/compile.
 */

import { describe, expect, it } from "bun:test";
import { agentComponent, type AnyAgentSpec } from "../src/agent-component.tsx";
import { analyzeAgent } from "../src/compile/graph.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { emitFlue, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { emitThink } from "../src/compile/emit-think.ts";
import { emitAgentModule } from "../src/compile/emit-agent-module.ts";

// A root with no authored model — legacy low-level specs omit it.
const Modelless = agentComponent({
  agentName: "modelless-root",
  initialState: {},
  impl: () => (
    <prompt>
      <sys p={10}>A root with no authored model.</sys>
    </prompt>
  ),
});

// A plain root that statically nests a child boundary of kind "ghost-child".
const GhostChild = agentComponent({
  agentName: "ghost-child",
  initialState: {},
  impl: () => (
    <prompt>
      <sys p={10}>A child that may or may not be registered downstream.</sys>
    </prompt>
  ),
});

const NestingRoot = agentComponent({
  agentName: "nesting-root",
  initialState: {},
  impl: () => (
    <>
      <GhostChild name="g" />
      <prompt>
        <sys p={10}>Nests a ghost child.</sys>
      </prompt>
    </>
  ),
});

const moduleOf = (component: { spec: AnyAgentSpec }, exportName: string) => ({
  spec: component.spec,
  exportName,
  importPath: `./${exportName.toLowerCase()}.tsx`,
});

describe("emitFlue — model is mandatory", () => {
  it("throws when neither spec.model nor FlueEmitOptions.model provides one", () => {
    expect(() =>
      emitFlue({
        spec: Modelless.spec,
        componentName: "Modelless",
        componentImport: "./modelless.tsx",
        analysis: analyzeAgent(moduleOf(Modelless, "Modelless")),
        runtimeImport: "./runtime",
      })
    ).toThrow(/\[agent-jsx\] flue agent "modelless-root" needs profile\.model or FlueEmitOptions\.model/);
  });

  it("accepts the model from EITHER source", () => {
    const viaOption = emitFlue({
      spec: Modelless.spec,
      model: "openrouter/openai/gpt-5-mini",
      componentName: "Modelless",
      componentImport: "./modelless.tsx",
      analysis: analyzeAgent(moduleOf(Modelless, "Modelless")),
      runtimeImport: "./runtime",
    });
    expect(viaOption).toContain('model: "openrouter/openai/gpt-5-mini",');

    const Modeled = agentComponent({
      agentName: "modeled-root",
      model: "openrouter/google/gemini-3.1-flash-lite-preview",
      initialState: {},
      impl: () => (
        <prompt>
          <sys p={10}>A root WITH an authored model.</sys>
        </prompt>
      ),
    });
    const viaSpec = emitFlue({
      spec: Modeled.spec,
      componentName: "Modeled",
      componentImport: "./modeled.tsx",
      analysis: analyzeAgent(moduleOf(Modeled, "Modeled")),
      runtimeImport: "./runtime",
    });
    expect(viaSpec).toContain('model: "openrouter/google/gemini-3.1-flash-lite-preview",');
  });
});

describe("emitFlue — a tool slot needs a registered child profile", () => {
  const slotted = (childProfiles: { importPath: string; profileExportName: string }[]) => ({
    spec: Modelless.spec,
    model: "openrouter/openai/gpt-5-mini",
    componentName: "Modelless",
    componentImport: "./modelless.tsx",
    analysis: analyzeAgent(moduleOf(Modelless, "Modelless")),
    childProfiles,
    toolSlots: [{ toolName: "onCall", childKind: "ghost-child", provider: "modelless-root", stableId: "w" }],
    runtimeImport: "./runtime",
  });

  it("throws when the binding's child kind has no matching profile", () => {
    expect(() => emitFlue(slotted([]))).toThrow(
      /flue tool slot: no child profile registered for kind "ghost-child"/
    );
  });

  it("resolves once the child profile is registered", () => {
    const out = emitFlue(
      slotted([{ importPath: "./ghost-child.flue.ts", profileExportName: flueProfileExportName("ghost-child") }])
    );
    expect(out).toContain('onCallSubagentProfile = defineAgentProfile({ ...ghost_childProfile, name: "onCall" });');
  });
});

describe("emitThink — an unregistered child kind is a hard error", () => {
  it("throws for a PLAIN nested kind no Think class was generated for", () => {
    expect(() =>
      emitThink(
        { spec: NestingRoot.spec, componentName: "NestingRoot", componentImport: "./nesting-root.tsx" },
        [], // GhostChild was composed but never registered as a child
        analyzeAgent(moduleOf(NestingRoot, "NestingRoot")),
        { runtimeImport: "./runtime" }
      )
    ).toThrow(/emitThink: no class registered for child kind "ghost-child"/);
  });

  it("throws for a tool-slot binding whose child kind has no Think class", () => {
    expect(() =>
      emitThink(
        { spec: Modelless.spec, componentName: "Modelless", componentImport: "./modelless.tsx" },
        [],
        analyzeAgent(moduleOf(Modelless, "Modelless")),
        {
          runtimeImport: "./runtime",
          toolSlots: [{ toolName: "onCall", childKind: "ghost-child", provider: "modelless-root", stableId: "w" }],
        }
      )
    ).toThrow(/emitThink: no class registered for child kind "ghost-child"/);
  });
});

describe("emitCloudflare — agentTools rejects an unregistered tool-slot kind", () => {
  const analysis = () => analyzeAgent(moduleOf(Modelless, "Modelless"));
  const root = { spec: Modelless.spec, componentName: "Modelless", componentImport: "./modelless.tsx" };
  const slots = [{ toolName: "onCall", childKind: "ghost-child", provider: "modelless-root", stableId: "w" }];

  it("throws when the slot's child kind was not passed as a child", () => {
    expect(() =>
      emitCloudflare(root, [], analysis(), {
        runtimeImport: "./runtime",
        agentTools: true,
        toolSlots: slots,
      })
    ).toThrow(/agentTools: no child registered for tool-slot kind "ghost-child"/);
  });

  it("ignores the same bindings when agentTools is off (version gate)", () => {
    const out = emitCloudflare(root, [], analysis(), {
      runtimeImport: "./runtime",
      toolSlots: slots,
    });
    expect(out.agents).not.toContain("agentTool");
    expect(out.agents).not.toContain("getTools()");
  });
});

describe("emitAgentModule — exportName must be a JavaScript identifier", () => {
  it.each([
    ["empty string", ""],
    ["leading digit", "1Agent"],
    ["embedded space", "Has Space"],
    ["member expression", "Foo.Bar"],
    ["dash", "Has-Dash"],
  ])("rejects %s", (_label, exportName) => {
    expect(() => emitAgentModule({ sourceImport: "../anything.agent.tsx", exportName })).toThrow(
      `[agent-jsx] exportName must be a JavaScript identifier; received ${JSON.stringify(exportName)}`
    );
  });

  it("accepts identifier characters beyond plain ASCII letters", () => {
    const out = emitAgentModule({ sourceImport: "../anything.agent.tsx", exportName: "_Valid$1" });
    expect(out).toContain("export const _Valid$1 = compileAgentClass(AgentDefinition);");
  });
});
