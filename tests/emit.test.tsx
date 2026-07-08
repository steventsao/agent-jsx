/**
 * Emitter contract tests — several are RED on purpose (TDD):
 *
 * 1. Emitters must accept a `runtimeImport` option so generated artifacts can
 *    resolve the agent-jsx runtime from wherever they're deployed (a compat
 *    package, a real worker) instead of hardcoding "../../src/...".
 * 2. The generated cloudflare module's runtime dependency closure must not
 *    pull react-reconciler or react-dom (React is dev-time only). The
 *    `react` core import is tolerated ONLY via the hook shim; prefer none.
 * 3. The wrangler fragment must be valid JSON with every generated class.
 */

import { describe, expect, it } from "bun:test";
import { analyze } from "../src/compile/analyze.ts";
import { emitCloudflare, type ChildAgentSpec } from "../src/compile/emit-cloudflare.ts";
import { emitFlue, emitFlueChild, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { createStore } from "../src/state.ts";
import { Investigator } from "../examples/investigator.tsx";
import { initialUptimeState, UptimeAgent, type UptimeState } from "../examples/uptime-agent.tsx";

const SITES = ["https://a.example", "https://b.example"];
const incident: UptimeState = {
  statuses: { "https://b.example": { state: "down", since: 4 } },
  findings: {},
};

const children: ChildAgentSpec[] = [
  { spec: Investigator.spec, exportName: "Investigator", importPath: "../agents/investigator.tsx" },
];

// The root is declared via agentComponent like every child; the emitter reads
// state shape + initial state + sample props from the spec (no stringly
// stateTypeName/initialStateExport/propsJson plumbing).
const root = {
  spec: UptimeAgent.spec,
  componentName: "UptimeAgent",
  componentImport: "../agents/uptime-agent.tsx",
};

// Rendering the ROOT means rendering its own tree (its impl) — a bare
// <UptimeAgent /> would be a subagent boundary (parent composition).
const UptimeImpl = UptimeAgent.spec.impl;
const analysis = () => {
  const samples = [initialUptimeState, incident];
  return analyze((i) => <UptimeImpl sites={SITES} store={createStore(samples[i]!)} />, samples.length);
};

describe("emitCloudflare", () => {
  it("honors runtimeImport for every runtime dependency", () => {
    const out = emitCloudflare(root, children, analysis(), { runtimeImport: "./runtime" });
    expect(out.agents).toContain(`from "./runtime/`);
    expect(out.agents).not.toContain("../../src/");
  });

  it("never imports the React machinery into the artifact", () => {
    const out = emitCloudflare(root, children, analysis(), { runtimeImport: "./runtime" });
    expect(out.agents).not.toContain("react-reconciler");
    expect(out.agents).not.toContain("react-dom");
    // reconciler.ts transitively imports react-reconciler — the collect
    // helpers the artifact needs must come from a react-free module.
    expect(out.agents).not.toContain("/reconciler");
  });

  it("emits one class per agent plus typed accessors and dispatcher", () => {
    const out = emitCloudflare(root, children, analysis(), { runtimeImport: "./runtime" });
    expect(out.agents).toContain("class UptimeDurable");
    expect(out.agents).toContain("class InvestigatorDurable");
    expect(out.agents).toContain("subagent(");
    expect(out.agents).toContain("onAgentEvent");
    expect(out.agents).toContain("setProps");
  });

  it("embeds initial state as JSON and imports NO initial-state export", () => {
    const out = emitCloudflare(root, children, analysis(), { runtimeImport: "./runtime" });
    // Initial state is embedded as a JSON literal derived from spec.initialState…
    expect(out.agents).toContain(`initialState = ${JSON.stringify(initialUptimeState)}`);
    // …so the old named initial-state export is neither imported nor referenced.
    expect(out.agents).not.toContain("initialUptimeState");
    // The component itself is still imported (for renderTree + structural typing).
    expect(out.agents).toContain(`import { UptimeAgent } from "../agents/uptime-agent.tsx";`);
    // The root renders its OWN tree via the spec's impl (not a bare component call).
    expect(out.agents).toContain("UptimeAgent.spec.impl(");
    // State is typed structurally off the spec — no stateTypeName string import.
    expect(out.agents).toContain("typeof UptimeAgent.spec.initialState & Record<string, unknown>");
  });

  it("derives class + binding names from spec.agentName", () => {
    const out = emitCloudflare(root, children, analysis(), { runtimeImport: "./runtime" });
    // pascal("uptime") + "Durable"; scream("uptime") binding.
    expect(out.agents).toContain("export class UptimeDurable extends FiberAgentBase<RootState>");
    expect(out.agents).toContain("UPTIME: DurableObjectNamespace;");
    expect(out.agents).toContain(`protected selfBinding = "UPTIME" as const;`);
  });

  it("emits a Cloudflare adapter flush loop around generated RPC writes", () => {
    const out = emitCloudflare(root, children, analysis(), { runtimeImport: "./runtime" });

    expect(out.agents).toContain("#reconciling = false;");
    expect(out.agents).toContain("#needsReconcile = false;");
    expect(out.agents).toContain(`do {
        this.#needsReconcile = false;
        await this.#reconcileOnce();
      } while (this.#needsReconcile);`);
    expect(out.agents).toContain("this.#needsReconcile = true;");
    expect(out.agents).toContain(`if (path.endsWith("/api/drive") && req.method === "POST") {
      await this.reconcile();`);
    expect(out.agents).toContain("async onStart() {}");
    expect(out.agents).toContain("async onStateChanged(_state?: ChildRuntimeState & Record<string, unknown>, _source?: unknown) {}");
    expect(out.agents).toContain("const childName = `${self}:${rec.name}`;");
    expect(out.agents).toContain('child: rec.name,');
    expect(out.agents).toContain(`this.setState({ ...this.state, __props: props, __callbacks: callbacks });`);
    expect(out.agents).not.toContain("deferReconcile");
    expect(out.agents).not.toContain("__fiber:reconcile");
    expect(out.agents).not.toContain(`this.setState({ ...this.state, __props: props, __callbacks: callbacks });
    await this.reconcile();`);
    expect(out.agents).toContain("if (this.#needsReconcile) await this.#requestReconcile();");
  });

  it("can bind a generated root onRequest handler for canonical /agents routes", () => {
    const out = emitCloudflare(
      {
        ...root,
        requestHandlerExport: "handleUptimeAgentRequest",
        requestHandlerImport: "./uptime.api.ts",
      },
      children,
      analysis(),
      { runtimeImport: "./runtime" }
    );

    expect(out.agents).toContain(`import { handleUptimeAgentRequest } from "./uptime.api.ts";`);
    expect(out.agents).toContain(`async onRequest(req: Request): Promise<Response> {
    return handleUptimeAgentRequest(req, this);
  }`);
  });

  it("wrangler fragment is valid JSON covering every class", () => {
    const out = emitCloudflare(root, children, analysis(), { runtimeImport: "./runtime" });
    const config = JSON.parse(out.wrangler.replace(/^\s*\/\/.*$/gm, ""));
    const classes = config.durable_objects.bindings.map((b: { class_name: string }) => b.class_name);
    expect(classes).toContain("UptimeDurable");
    expect(classes).toContain("InvestigatorDurable");
    expect(config.migrations[0].new_sqlite_classes).toEqual(classes);
  });
});

describe("emitFlue", () => {
  it("honors runtimeImport and never emits .tsx module filenames", () => {
    const parent = emitFlue({
      spec: UptimeAgent.spec,
      model: "openrouter/google/gemini-3.1-flash-lite-preview",
      componentName: "UptimeAgent",
      componentImport: "../agents/uptime-agent.tsx",
      analysis: analysis(),
      childProfiles: [
        { importPath: "./investigator.flue.ts", profileExportName: flueProfileExportName("investigator") },
      ],
      runtimeImport: "./runtime",
    });
    expect(parent).toContain(`from "./runtime/`);
    expect(parent).not.toContain("../../src/");
    expect(parent).toContain(`import { investigatorProfile } from "./investigator.flue.ts";`);
    expect(parent).toContain("subagents: [investigatorProfile]");
  });

  it("child profile embeds the resting prompt as instructions", () => {
    const profile = emitFlueChild(children[0]!, 400, { runtimeImport: "./runtime" });
    expect(profile).toContain("defineAgentProfile");
    expect(profile).toContain("You investigate ONE outage");
  });
});
