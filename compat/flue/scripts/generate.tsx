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
console.log("generated: src/generated/{uptime,investigator}.flue.ts + uptime.workflow.ts + runtime/");
