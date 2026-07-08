/**
 * Compile the example agents into this package:
 *   src/agents/     — the two component files, copied verbatim (you write these)
 *   src/generated/  — emitted classes + runtime, wrangler fragment
 *
 * The emitters must support `runtimeImport` and a react-free runtime file
 * set for this to work (tests/emit.test.ts in the repo root defines that
 * contract). Extend the emitters, not this script, when something fails.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { analyze } from "../../../src/compile/analyze.ts";
import { emitCloudflare, type ChildAgentSpec } from "../../../src/compile/emit-cloudflare.ts";
import { copyAgentComponent } from "../../../src/compile/runtime-files.ts";
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

// 1. The human-authored inputs travel in, with their `../src/...` imports
//    rewritten onto the emitted react-free runtime (state.ts -> store.ts's
//    read-only useAgentState; agent-component.tsx). From src/agents/ the
//    runtime lives at ../generated/runtime.
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

// 2. Emit classes + wrangler with a package-local runtime import base.
const children: ChildAgentSpec[] = [
  { spec: Investigator.spec, exportName: "Investigator", importPath: "../agents/investigator.tsx" },
];
const samples = [initialUptimeState, incident];
const UptimeImpl = UptimeAgent.spec.impl;
const out = emitCloudflare(
  { spec: UptimeAgent.spec, componentName: "UptimeAgent", componentImport: "../agents/uptime-agent.tsx" },
  children,
  analyze((i) => <UptimeImpl sites={SITES} store={createStore(samples[i]!)} />, samples.length),
  { runtimeImport: "./runtime", emitRuntimeTo: here("src/generated/runtime").pathname }
);

writeFileSync(here("src/generated/uptime.cloudflare.ts"), out.agents);
writeFileSync(here("src/generated/uptime.wrangler.jsonc"), out.wrangler);
console.log("generated: src/generated/uptime.cloudflare.ts + runtime/ + wrangler fragment");
