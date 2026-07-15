/**
 * LIVE deploy build: same two component files, production-ish knobs.
 *   - sites come from the spec's sampleProps (the emitter reads ROOT props from
 *     the spec now, not a per-emit propsJson). The *.example hosts never
 *     resolve → they read as down, a permanent incident for the demo to chew on.
 *   - intervalScale 5: authored tick = 5s wall clock → sensors poll every 10s,
 *     the investigator's SLA deadline fires at 40s
 * Deploy: bunx wrangler deploy -c wrangler.deploy.jsonc
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createElement } from "react";
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

// Root props (the sites) live in the spec now — the deploy uses the spec's
// representative sites so the analysis matches what the deployed root runs with.
const SITES = UptimeAgent.spec.sampleProps!.sites;
const incident: UptimeState = {
  statuses: { "https://b.example": { state: "down", since: 0 } },
  findings: {},
};

const here = (p: string) => new URL(`../${p}`, import.meta.url);
mkdirSync(here("src/agents"), { recursive: true });
mkdirSync(here("src/deploy-generated"), { recursive: true });

copyAgentComponent(
  new URL("../../../examples/uptime-agent.tsx", import.meta.url),
  here("src/agents/uptime-agent.tsx").pathname,
  "../deploy-generated/runtime"
);
copyAgentComponent(
  new URL("../../../examples/investigator.tsx", import.meta.url),
  here("src/agents/investigator.tsx").pathname,
  "../deploy-generated/runtime"
);

const children: ChildAgentSpec[] = [
  { spec: Investigator.spec, exportName: "Investigator", importPath: "../agents/investigator.tsx" },
];
const samples = [initialUptimeState, incident];
const UptimeImpl = UptimeAgent.spec.impl;
const out = emitCloudflare(
  { spec: UptimeAgent.spec, componentName: "UptimeAgent", componentImport: "../agents/uptime-agent.tsx" },
  children,
  analyze(
    (i) => createElement(UptimeImpl, { sites: SITES, store: createStore(samples[i]!) }),
    samples.length,
  ),
  {
    runtimeImport: "./runtime",
    emitRuntimeTo: here("src/deploy-generated/runtime").pathname,
    intervalScale: 5,
  }
);

writeFileSync(here("src/deploy-generated/uptime.cloudflare.ts"), out.agents);

// wrangler config: the emitted DO fragment + deploy plumbing.
const fragment = JSON.parse(out.wrangler.replace(/^\s*\/\/.*$/gm, ""));
const config = {
  name: "agent-jsx-demo",
  main: "src/worker-deploy.ts",
  compatibility_date: "2026-06-01",
  compatibility_flags: ["nodejs_compat"],
  observability: { enabled: true },
  ...fragment,
};
writeFileSync(here("wrangler.deploy.jsonc"), JSON.stringify(config, null, 2) + "\n");
console.log("deploy build: src/deploy-generated/ + wrangler.deploy.jsonc");
