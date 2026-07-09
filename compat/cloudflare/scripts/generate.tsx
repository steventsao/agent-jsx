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
import { discoverAgents } from "../../../src/compile/graph.ts";
import { copyAgentComponent } from "../../../src/compile/runtime-files.ts";
import { createStore } from "../../../src/state.ts";
import { Investigator } from "../../../examples/investigator.tsx";
import {
  initialUptimeState,
  UptimeAgent,
  type UptimeState,
} from "../../../examples/uptime-agent.tsx";
import { ContRoot } from "../../../examples/continuation-min/parent.tsx";
import { ContEmitter } from "../../../examples/continuation-min/emitter.tsx";
import { ContFolder } from "../../../examples/continuation-min/folder.tsx";

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

// 3. The continuation pair (Phase 0 e2e): the SAME continuation shape as
//    layout-review but pure-compute, so the whole __emit → __outputs → grandchild
//    round-trip is deterministic on real workerd. Discover the graph transitively
//    (root cont-root nests cont-emitter statically + cont-folder via its own
//    render-prop continuation, expanded at the emitter's sampleOutput). Runtime
//    is shared with the uptime emit above (runtimeImport "./runtime"), so no
//    re-copy is needed.
copyAgentComponent(
  new URL("../../../examples/continuation-min/parent.tsx", import.meta.url),
  here("src/agents/parent.tsx").pathname,
  "../generated/runtime"
);
copyAgentComponent(
  new URL("../../../examples/continuation-min/emitter.tsx", import.meta.url),
  here("src/agents/emitter.tsx").pathname,
  "../generated/runtime"
);
copyAgentComponent(
  new URL("../../../examples/continuation-min/folder.tsx", import.meta.url),
  here("src/agents/folder.tsx").pathname,
  "../generated/runtime"
);

const contGraph = discoverAgents(
  { spec: ContRoot.spec, exportName: "ContRoot", importPath: "../agents/parent.tsx" },
  [
    { spec: ContEmitter.spec, exportName: "ContEmitter", importPath: "../agents/emitter.tsx" },
    { spec: ContFolder.spec, exportName: "ContFolder", importPath: "../agents/folder.tsx" },
  ]
);
const cont = emitCloudflare(
  { spec: contGraph[0]!.spec, componentName: "ContRoot", componentImport: "../agents/parent.tsx" },
  contGraph.slice(1).map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath })),
  contGraph[0]!.analysis,
  { runtimeImport: "./runtime" }
);
writeFileSync(here("src/generated/continuation.cloudflare.ts"), cont.agents);
writeFileSync(here("src/generated/continuation.wrangler.jsonc"), cont.wrangler);
console.log("generated: src/generated/continuation.cloudflare.ts (cont-root → cont-emitter → cont-folder)");
