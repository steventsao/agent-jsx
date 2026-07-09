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
import { analyzeAgent, discoverAgents, type AgentModule } from "../src/compile/graph.ts";
import { discoverToolSlots } from "../src/compile/slots.ts";
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
import {
  initialLayoutAnalystState,
  LayoutAnalyst,
} from "../examples/layout-review/layout-analyst.tsx";
import { LayoutReviewer, type ReviewPage } from "../examples/layout-review/layout-reviewer.tsx";
import { BboxExtractor } from "../examples/pdf/bbox-extractor.tsx";
import { ResearchDesk, initialResearchDeskState } from "../examples/tool-slot/research-desk.tsx";
import { Worker } from "../examples/tool-slot/worker.tsx";
import { Summarizer } from "../examples/tool-slot/summarizer.tsx";
import { Coordinator } from "../examples/tool-slot/coordinator.tsx";

export const SITES = ["https://a.example", "https://b.example", "https://c.example"];
const MODEL = "openrouter/google/gemini-3.1-flash-lite-preview";

const incident: UptimeState = {
  statuses: { "https://b.example": { state: "down", since: 4 } },
  findings: {},
};

// A loaded page with two detected regions — the sample that makes the
// reviewer's per-region fan-out visible as DYNAMIC (vs the always-on header).
const loadedPage: ReviewPage = {
  id: "p1",
  pdfB64: "stub",
  regions: [
    { id: "r1", bbox: { x0: 0, y0: 0.2, x1: 1, y1: 0.5 } },
    { id: "r2", bbox: { x0: 0, y0: 0.5, x1: 1, y1: 0.9 } },
  ],
};

/**
 * The 3-level static hierarchy (layout-analyst → layout-reviewer →
 * bbox-extractor), discovered transitively from the root and emitted as: one
 * cloudflare module with a Durable Object class per level, and one flue module
 * per level with native `subagents:` arrays (mid profile carries its own).
 */
export function buildLayoutFixtures(): Record<string, string> {
  const rootModule: AgentModule = {
    spec: LayoutAnalyst.spec,
    exportName: "LayoutAnalyst",
    importPath: "../agents/layout-analyst.tsx",
    samples: [{ state: initialLayoutAnalystState }, { state: { page: loadedPage, segments: {}, verdict: null } }],
  };
  const reviewerModule: AgentModule = {
    spec: LayoutReviewer.spec,
    exportName: "LayoutReviewer",
    importPath: "../agents/layout-reviewer.tsx",
    samples: [
      { props: { page: null }, state: { detected: false } },
      { props: { page: loadedPage }, state: { detected: false } },
    ],
  };
  const bboxModule: AgentModule = {
    spec: BboxExtractor.spec,
    exportName: "BboxExtractor",
    importPath: "../agents/bbox-extractor.tsx",
  };

  const graph = discoverAgents(rootModule, [reviewerModule, bboxModule]);
  const [rootNode, reviewerNode, bboxNode] = graph;
  const profileImports = (kinds: string[]) =>
    kinds.map((kind) => ({
      importPath: `./${kind}.flue.ts`,
      profileExportName: flueProfileExportName(kind),
    }));

  const cf = emitCloudflare(
    { spec: rootNode!.spec, componentName: rootNode!.exportName, componentImport: rootNode!.importPath },
    graph.slice(1).map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath })),
    rootNode!.analysis,
    { runtimeImport: "./runtime" }
  );

  return {
    "layout-analyst.cloudflare.ts": cf.agents,
    "layout-analyst.wrangler.jsonc": cf.wrangler,
    "layout-analyst.flue.ts": emitFlue({
      spec: rootNode!.spec,
      model: MODEL,
      componentName: rootNode!.exportName,
      componentImport: rootNode!.importPath,
      analysis: rootNode!.analysis,
      childProfiles: profileImports(rootNode!.directChildren),
      runtimeImport: "./runtime",
    }),
    "layout-reviewer.flue.ts": emitFlueChild(
      { spec: reviewerNode!.spec, exportName: reviewerNode!.exportName, importPath: reviewerNode!.importPath },
      400,
      {
        runtimeImport: "./runtime",
        childProfiles: profileImports(reviewerNode!.directChildren),
        analysis: reviewerNode!.analysis,
      }
    ),
    "bbox-extractor.flue.ts": emitFlueChild(
      { spec: bboxNode!.spec, exportName: bboxNode!.exportName, importPath: bboxNode!.importPath },
      400,
      { runtimeImport: "./runtime" }
    ),
  };
}

/**
 * The SCHEMA-DRIVEN family: a root (research-desk) composes two schema'd children
 * (tool-worker, tool-summarizer) as normal boundaries. Emitted so the schema
 * contract is visible in committed fixtures — the cloudflare child classes carry
 * `@boundarySchema` docs, and the flue profiles carry `description`.
 */
export function buildSchemaFixtures(): Record<string, string> {
  const rootModule: AgentModule = {
    spec: ResearchDesk.spec,
    exportName: "ResearchDesk",
    importPath: "../agents/research-desk.tsx",
    // The children are state-gated on a query; the second sample (query set)
    // surfaces them for discovery with a schema-valid query.
    samples: [{ state: initialResearchDeskState }, { state: { query: "revenue", results: {} } }],
  };
  const workerModule: AgentModule = { spec: Worker.spec, exportName: "Worker", importPath: "../agents/worker.tsx" };
  const summarizerModule: AgentModule = {
    spec: Summarizer.spec,
    exportName: "Summarizer",
    importPath: "../agents/summarizer.tsx",
  };

  const graph = discoverAgents(rootModule, [workerModule, summarizerModule]);
  const rootNode = graph[0]!;
  const profileImports = (kinds: string[]) =>
    kinds.map((kind) => ({ importPath: `./${kind}.flue.ts`, profileExportName: flueProfileExportName(kind) }));

  const cf = emitCloudflare(
    { spec: rootNode.spec, componentName: rootNode.exportName, componentImport: rootNode.importPath },
    graph.slice(1).map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath })),
    rootNode.analysis,
    { runtimeImport: "./runtime" }
  );

  return {
    "research-desk.cloudflare.ts": cf.agents,
    "research-desk.wrangler.jsonc": cf.wrangler,
    "research-desk.flue.ts": emitFlue({
      spec: rootNode.spec,
      model: MODEL,
      componentName: rootNode.exportName,
      componentImport: rootNode.importPath,
      analysis: rootNode.analysis,
      childProfiles: profileImports(rootNode.directChildren),
      runtimeImport: "./runtime",
    }),
    "tool-worker.flue.ts": emitFlueChild(
      { spec: Worker.spec, exportName: "Worker", importPath: "../agents/worker.tsx" },
      400,
      { runtimeImport: "./runtime" }
    ),
    "tool-summarizer.flue.ts": emitFlueChild(
      { spec: Summarizer.spec, exportName: "Summarizer", importPath: "../agents/summarizer.tsx" },
      400,
      { runtimeImport: "./runtime" }
    ),
  };
}

/**
 * The TOOL-SLOT family (Steven's acceptance example): the SAME coordinator
 * (names no child) composed TWICE, its `onCall` slot filled by a different child
 * each time. The cloudflare fixtures show the version-gated getTools() diff
 * (onCall → agentTool(ToolWorkerDurable) vs agentTool(ToolSummarizerDurable));
 * the flue fixtures show the native subagents: roster diff. Both children satisfy
 * the same slot — hierarchy comes from the composition site.
 */
export function buildToolSlotFixtures(): Record<string, string> {
  const root = { spec: Coordinator.spec, componentName: "Coordinator", componentImport: "../agents/coordinator.tsx" };
  const analysis = analyzeAgent({
    spec: Coordinator.spec,
    exportName: "Coordinator",
    importPath: "../agents/coordinator.tsx",
  });

  const withWorker = <Coordinator name="coord">{(h) => <Worker name="w" onCall={h} />}</Coordinator>;
  const withSummarizer = <Coordinator name="coord">{(h) => <Summarizer name="s" onCall={h} />}</Coordinator>;

  const cf = (child: { spec: typeof Worker.spec }, exportName: string, importFile: string, composition: unknown) =>
    emitCloudflare(root, [{ spec: child.spec, exportName, importPath: `../agents/${importFile}` }], analysis, {
      runtimeImport: "./runtime",
      agentTools: true,
      toolSlots: discoverToolSlots(composition),
    }).agents;

  const flue = (kind: string) =>
    emitFlue({
      spec: Coordinator.spec,
      model: MODEL,
      componentName: "Coordinator",
      componentImport: "../agents/coordinator.tsx",
      analysis,
      childProfiles: [{ importPath: `./${kind}.flue.ts`, profileExportName: flueProfileExportName(kind) }],
      runtimeImport: "./runtime",
    });

  return {
    "coordinator.worker.cloudflare.ts": cf(Worker, "Worker", "worker.tsx", withWorker),
    "coordinator.summarizer.cloudflare.ts": cf(Summarizer, "Summarizer", "summarizer.tsx", withSummarizer),
    "coordinator.worker.flue.ts": flue("tool-worker"),
    "coordinator.summarizer.flue.ts": flue("tool-summarizer"),
  };
}

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
    ...buildLayoutFixtures(),
    ...buildSchemaFixtures(),
    ...buildToolSlotFixtures(),
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
