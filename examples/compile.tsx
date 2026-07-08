/**
 * Compile the SAME component down to real runtimes.
 *
 * Step 1 is the load-bearing proof: React render+commit and the ~70-line
 * React-free evaluator produce BYTE-IDENTICAL desired infra and prompt text.
 * The host diffs full desired state by (kind, name) every commit, so React's
 * incremental fiber diffing is redundant at runtime — which means React can
 * be a dev-time tool (StrictMode, keys, tests, mental model) and the shipped
 * artifact is plain actor code.
 *
 * Step 2 splits static vs dynamic capability by partial evaluation (evaluate
 * at N sample states; present-in-all = static).
 *
 * Step 3 emits the COMPOSITION GLUE — you only write agent component files:
 *   - uptime.cloudflare.ts — one Agent class per component (parent + child)
 *     over a generated FiberAgentBase: typed `this.subagent(kind, name)`
 *     accessors, setProps RPC (props across the actor boundary), CallbackRef
 *     proxies (function props across the boundary), one event dispatcher.
 *   - uptime.wrangler.jsonc — DO bindings + migrations for every class.
 *   - uptime.flue.ts + investigator.flue.ts — parent module + child profile
 *     with spawnPlan(state) for the dynamic residue.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { mountAgent } from "../src/agent.ts";
import { analyze } from "../src/compile/analyze.ts";
import { emitCloudflare, type ChildAgentSpec } from "../src/compile/emit-cloudflare.ts";
import { emitFlue, emitFlueChild, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { renderPrompt } from "../src/prompt.ts";
import { collectInfra, collectPrompt } from "../src/reconciler.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import type { InfraRecord } from "../src/types.ts";
import { Investigator } from "./investigator.tsx";
import { initialUptimeState, UptimeAgent, type UptimeState } from "./uptime-agent.tsx";

const SITES = ["https://a.example", "https://b.example", "https://c.example"];
const world = { statusAt: () => 200 };
const BUDGET = 95;

// Mounting/evaluating the ROOT agent means rendering its own tree — its impl,
// the same function the generated root class calls via .spec.impl. A bare
// `<UptimeAgent .../>` would compile to a subagent boundary (parent composition).
const UptimeImpl = UptimeAgent.spec.impl;

const incidentState: UptimeState = {
  statuses: {
    "https://a.example": { state: "up", since: 2 },
    "https://b.example": { state: "down", since: 4 },
  },
  findings: {},
};

const normalize = (records: InfraRecord[]) =>
  records
    .map(({ kind, name, config }) => ({ kind, name, config }))
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));

// ---------------------------------------------------------------------------
console.log("1. PARITY — React render+commit vs React-free evaluation\n");

// React path: real hooks, real reconciler, real commit sweep.
const reactStore = createStore<UptimeState>(incidentState);
const reactHost = new SimHost(world);
const reactAgent = mountAgent(<UptimeImpl sites={SITES} store={reactStore} />, reactHost, {
  quiet: true,
});
const viaReact = normalize(
  [...reactHost.liveRecords.values()].map(({ kind, name, config, handlers }) => ({
    kind,
    name,
    config,
    handlers,
  }))
);
const promptViaReact = reactAgent.prompt(BUDGET).text;
reactAgent.unmount();

// Evaluator path: no React import touched at runtime.
const evalStore = createStore<UptimeState>(incidentState);
const roots = evaluateTree(<UptimeImpl sites={SITES} store={evalStore} />);
const viaEvaluator = normalize(roots.flatMap((r) => collectInfra(r)));
const promptViaEvaluator = renderPrompt(collectPrompt(roots), BUDGET).text;

const infraEqual = JSON.stringify(viaReact) === JSON.stringify(viaEvaluator);
const promptEqual = promptViaReact === promptViaEvaluator;
console.log(`   infra  (${viaEvaluator.length} records): ${infraEqual ? "✓ identical" : "✗ DIVERGED"}`);
console.log(`   prompt (${promptViaEvaluator.length} chars):   ${promptEqual ? "✓ identical" : "✗ DIVERGED"}`);
if (!infraEqual || !promptEqual) {
  console.log(JSON.stringify({ viaReact, viaEvaluator, promptViaReact, promptViaEvaluator }, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log("\n2. STATIC/DYNAMIC SPLIT — partial evaluation at sample states\n");

const samples = [initialUptimeState, incidentState];
const analysis = analyze(
  (i) => <UptimeImpl sites={SITES} store={createStore(samples[i]!)} />,
  samples.length
);
for (const r of analysis.static) console.log(`   static   ${r.kind}:${r.name}`);
for (const r of analysis.dynamic) console.log(`   dynamic  ${r.kind}:${r.name}  (state-gated)`);

// ---------------------------------------------------------------------------
console.log("\n3. EMIT\n");

mkdirSync(new URL("./generated/", import.meta.url), { recursive: true });
const out = (file: string, content: string) => {
  writeFileSync(new URL(`./generated/${file}`, import.meta.url), content);
  console.log(`   wrote examples/generated/${file} (${content.split("\n").length} lines)`);
};

const children: ChildAgentSpec[] = [
  { spec: Investigator.spec, exportName: "Investigator", importPath: "../investigator.tsx" },
];

const cf = emitCloudflare(
  { spec: UptimeAgent.spec, componentName: "UptimeAgent", componentImport: "../uptime-agent.tsx" },
  children,
  analysis
);
out("uptime.cloudflare.ts", cf.agents);
out("uptime.wrangler.jsonc", cf.wrangler);

out(
  "uptime.flue.ts",
  emitFlue({
    spec: UptimeAgent.spec,
    model: "openrouter/google/gemini-3.1-flash-lite-preview",
    componentName: "UptimeAgent",
    componentImport: "../uptime-agent.tsx",
    analysis,
    childProfiles: [
      { importPath: "./investigator.flue.ts", profileExportName: flueProfileExportName("investigator") },
    ],
  })
);
for (const child of children) out(`${child.spec.agentName}.flue.ts`, emitFlueChild(child));

console.log(
  "\n   You wrote 2 component files. Generated: 2 DO classes + subagent/callback\n" +
    "   RPC glue + wrangler bindings/migrations + flue parent module + child profile."
);
