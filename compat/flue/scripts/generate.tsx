/**
 * Emit the flue targets into this package with a package-local runtime.
 * Same inputs as the cloudflare compat package: the two component files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { analyze } from "../../../src/compile/analyze.ts";
import { copyAgentComponent } from "../../../src/compile/runtime-files.ts";
import {
  emitFlue,
  emitFlueChild,
  emitFlueWorkflow,
  flueProfileExportName,
} from "../../../src/compile/emit-flue.ts";
import { createStore } from "../../../src/state.ts";
import { Investigator } from "../../../examples/investigator.tsx";
import { Worker } from "../../../examples/tool-slot/worker.tsx";
import { Notetaker } from "../../../examples/think/notetaker.tsx";
import { Researcher } from "../../../examples/think/researcher.tsx";
import { analyzeAgent } from "../../../src/compile/graph.ts";
import {
  initialUptimeState,
  UptimeAgent,
  type UptimeState,
} from "../../../examples/uptime-agent.tsx";

const SITES = ["https://a.example", "https://b.example", "https://c.example"];
const incident: UptimeState = {
  statuses: { "https://b.example": { state: "down", since: 4 } },
  findings: {},
};

const here = (p: string) => new URL(`../${p}`, import.meta.url);
mkdirSync(here("src/agents"), { recursive: true });
mkdirSync(here("src/generated"), { recursive: true });
copyAgentComponent(
  new URL("../../../examples/uptime-agent.tsx", import.meta.url),
  here("src/agents/uptime-agent.tsx").pathname,
  "../generated/runtime"
);
copyAgentComponent(
  new URL("../../../examples/investigator.tsx", import.meta.url),
  here("src/agents/investigator.tsx").pathname,
  "../generated/runtime"
);

const samples = [initialUptimeState, incident];
const UptimeImpl = UptimeAgent.spec.impl;
const analysis = analyze((i) => <UptimeImpl sites={SITES} store={createStore(samples[i]!)} />, samples.length);

writeFileSync(
  here("src/generated/uptime.flue.ts"),
  emitFlue({
    spec: UptimeAgent.spec,
    model: "openrouter/google/gemini-3.1-flash-lite-preview",
    componentName: "UptimeAgent",
    componentImport: "../agents/uptime-agent.tsx",
    analysis,
    childProfiles: [
      { importPath: "./investigator.flue.ts", profileExportName: flueProfileExportName("investigator") },
    ],
    runtimeImport: "./runtime",
    emitRuntimeTo: here("src/generated/runtime").pathname,
  })
);
writeFileSync(
  here("src/generated/investigator.flue.ts"),
  emitFlueChild(
    { spec: Investigator.spec, exportName: "Investigator", importPath: "../agents/investigator.tsx" },
    400,
    { runtimeImport: "./runtime" }
  )
);

// A SCHEMA-DRIVEN child profile: proves the emitted `description` (from the
// spec) survives flue's real defineAgentProfile validation. A leaf profile
// imports no runtime/zod, so no extra deps in this package.
writeFileSync(
  here("src/generated/tool-worker.flue.ts"),
  emitFlueChild(
    { spec: Worker.spec, exportName: "Worker", importPath: "../agents/worker.tsx" },
    400,
    { runtimeImport: "./runtime" }
  )
);

// PHASE 3 — the <tool> gap-closer: a ROOT agent (Notetaker) with a STATIC
// <tool> (saveNote) emits `tools: [defineTool(...)]` on its defineAgent config.
// Importing the module + calling initialize() runs flue's real defineTool
// validator (the oracle); the run re-renders the component to dispatch the
// freshest <tool> closure. Notetaker nests Researcher (its subagents roster).
copyAgentComponent(
  new URL("../../../examples/think/notetaker.tsx", import.meta.url),
  here("src/agents/notetaker.tsx").pathname,
  "../generated/runtime"
);
copyAgentComponent(
  new URL("../../../examples/think/researcher.tsx", import.meta.url),
  here("src/agents/researcher.tsx").pathname,
  "../generated/runtime"
);
writeFileSync(
  here("src/generated/notetaker.flue.ts"),
  emitFlue({
    spec: Notetaker.spec,
    model: "openrouter/google/gemini-3.1-flash-lite-preview",
    componentName: "Notetaker",
    componentImport: "../agents/notetaker.tsx",
    analysis: analyzeAgent({ spec: Notetaker.spec, exportName: "Notetaker", importPath: "../agents/notetaker.tsx" }),
    childProfiles: [
      { importPath: "./researcher.flue.ts", profileExportName: flueProfileExportName("researcher") },
    ],
    runtimeImport: "./runtime",
  })
);
writeFileSync(
  here("src/generated/researcher.flue.ts"),
  emitFlueChild(
    { spec: Researcher.spec, exportName: "Researcher", importPath: "../agents/researcher.tsx" },
    400,
    { runtimeImport: "./runtime" }
  )
);

// v0.5: the reactive workflow module — flue's state→render loop. Imports the
// executor (copied into runtime/ by emitFlue above) and the generated
// defineAgent (uptime.flue.ts default export) as the workflow agent.
writeFileSync(
  here("src/generated/uptime.workflow.ts"),
  emitFlueWorkflow({
    spec: UptimeAgent.spec,
    componentName: "UptimeAgent",
    componentImport: "../agents/uptime-agent.tsx",
    agentModuleImport: "./uptime.flue.ts",
    runtimeImport: "./runtime",
  })
);
console.log(
  "generated: src/generated/{uptime,investigator,notetaker,researcher}.flue.ts + uptime.workflow.ts + runtime/"
);
