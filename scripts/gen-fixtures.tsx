/**
 * Canonical fixtures: the exact artifacts the compiler produces from the two
 * example component files, checked into git as golden files.
 *
 * They serve three purposes:
 *   1. Documentation — "you write components, this is what ships" is readable
 *      in the repo without running anything.
 *   2. Regression lock — tests/fixtures.test.tsx asserts the emitters
 *      reproduce these byte-for-byte, so every emitter change shows up as a
 *      reviewable fixture diff.
 *   3. Deploy source — the live demo deploys artifacts generated with the
 *      same inputs (different sites/scale, see compat/cloudflare).
 *
 * Regenerate: bun run fixtures
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { analyze } from "../src/compile/analyze.ts";
import { emitCloudflare, type ChildAgentSpec } from "../src/compile/emit-cloudflare.ts";
import {
  emitFlue,
  emitFlueChild,
  emitFlueWorkflow,
  flueProfileExportName,
} from "../src/compile/emit-flue.ts";
import { createStore } from "../src/state.ts";
import { Investigator } from "../examples/investigator.tsx";
import { initialUptimeState, UptimeAgent, type UptimeState } from "../examples/uptime-agent.tsx";

export const SITES = ["https://a.example", "https://b.example", "https://c.example"];

const incident: UptimeState = {
  statuses: { "https://b.example": { state: "down", since: 4 } },
  findings: {},
};

export function buildFixtures(): Record<string, string> {
  // Rendering the ROOT means rendering its own tree (its impl) — the same
  // function the generated root class calls via .spec.impl.
  const UptimeImpl = UptimeAgent.spec.impl;
  const samples = [initialUptimeState, incident];
  const analysis = analyze(
    (i) => <UptimeImpl sites={SITES} store={createStore(samples[i]!)} />,
    samples.length
  );
  const children: ChildAgentSpec[] = [
    { spec: Investigator.spec, exportName: "Investigator", importPath: "../agents/investigator.tsx" },
  ];
  // The emitter consumes ONLY the spec (state shape + initial state + sample
  // props live in the component file) plus the module-locating name/path.
  const root = {
    spec: UptimeAgent.spec,
    componentName: "UptimeAgent",
    componentImport: "../agents/uptime-agent.tsx",
  };

  const cf = emitCloudflare(root, children, analysis, { runtimeImport: "./runtime" });

  return {
    "uptime.cloudflare.ts": cf.agents,
    "uptime.wrangler.jsonc": cf.wrangler,
    "uptime.flue.ts": emitFlue({
      spec: UptimeAgent.spec,
      model: "openrouter/google/gemini-3.1-flash-lite-preview",
      componentName: "UptimeAgent",
      componentImport: "../agents/uptime-agent.tsx",
      analysis,
      childProfiles: [
        { importPath: "./investigator.flue.ts", profileExportName: flueProfileExportName("investigator") },
      ],
      runtimeImport: "./runtime",
    }),
    "investigator.flue.ts": emitFlueChild(children[0]!, 400, { runtimeImport: "./runtime" }),
    "uptime.workflow.ts": emitFlueWorkflow({
      spec: UptimeAgent.spec,
      componentName: "UptimeAgent",
      componentImport: "../agents/uptime-agent.tsx",
      agentModuleImport: "./uptime.flue.ts",
      runtimeImport: "./runtime",
    }),
  };
}

if (import.meta.main) {
  const dir = new URL("../fixtures/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const fixtures = buildFixtures();
  for (const [name, content] of Object.entries(fixtures)) {
    writeFileSync(new URL(name, dir), content);
    console.log(`fixtures/${name} (${content.split("\n").length} lines)`);
  }
}
