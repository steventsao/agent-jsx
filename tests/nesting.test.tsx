/**
 * Multi-level STATIC nesting — the layout-review example (layout-analyst →
 * layout-reviewer → bbox-extractor). These are RED until the compiler learns
 * to (1) discover child agents transitively, (2) emit a Durable Object class
 * per level with its OWN childBinding, and (3) emit flue's native `subagents:`
 * arrays at every level while keeping ONLY the dynamic residue in spawnPlan.
 */

import { describe, expect, it } from "bun:test";
import { discoverAgents, type AgentModule } from "../src/compile/graph.ts";
import { emitCloudflare, type ChildAgentSpec } from "../src/compile/emit-cloudflare.ts";
import { emitFlue, emitFlueChild, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { LayoutAnalyst, initialLayoutAnalystState } from "../examples/layout-review/layout-analyst.tsx";
import { LayoutReviewer, type ReviewPage } from "../examples/layout-review/layout-reviewer.tsx";
import { BboxExtractor } from "../examples/pdf/bbox-extractor.tsx";

const loadedPage: ReviewPage = {
  id: "p1",
  pdfB64: "stub",
  regions: [
    { id: "r1", bbox: { x0: 0, y0: 0.2, x1: 1, y1: 0.5 } },
    { id: "r2", bbox: { x0: 0, y0: 0.5, x1: 1, y1: 0.9 } },
  ],
};

const rootModule: AgentModule = {
  spec: LayoutAnalyst.spec,
  exportName: "LayoutAnalyst",
  importPath: "../agents/layout-analyst.tsx",
  samples: [
    { state: initialLayoutAnalystState },
    { state: { page: loadedPage, verdict: null } },
  ],
};

const reviewerModule: AgentModule = {
  spec: LayoutReviewer.spec,
  exportName: "LayoutReviewer",
  importPath: "../agents/layout-reviewer.tsx",
  samples: [
    { props: { page: null }, state: { segments: {} } },
    { props: { page: loadedPage }, state: { segments: {} } },
  ],
};

const bboxModule: AgentModule = {
  spec: BboxExtractor.spec,
  exportName: "BboxExtractor",
  importPath: "../agents/bbox-extractor.tsx",
};

const ids = (records: { kind: string; name: string }[]) => records.map((r) => `${r.kind}:${r.name}`);

describe("recursive boundary discovery", () => {
  it("discovers the 3-level graph transitively, root first, de-duped by agentName", () => {
    const graph = discoverAgents(rootModule, [reviewerModule, bboxModule]);
    expect(graph.map((n) => n.spec.agentName)).toEqual([
      "layout-analyst",
      "layout-reviewer",
      "bbox-extractor",
    ]);
    expect(graph[0]!.isRoot).toBe(true);
    expect(graph[1]!.isRoot).toBe(false);
  });

  it("records each level's direct children (its own boundaries only)", () => {
    const graph = discoverAgents(rootModule, [reviewerModule, bboxModule]);
    expect(graph[0]!.directChildren).toEqual(["layout-reviewer"]);
    expect(graph[1]!.directChildren).toEqual(["bbox-extractor"]);
    expect(graph[2]!.directChildren).toEqual([]);
  });

  it("splits static vs dynamic per level", () => {
    const graph = discoverAgents(rootModule, [reviewerModule, bboxModule]);
    // Root ALWAYS renders the reviewer → static.
    expect(ids(graph[0]!.analysis.static)).toContain("subagent:review:main");
    // Reviewer ALWAYS renders the header extractor → static; the per-region
    // fan-out is dynamic.
    expect(ids(graph[1]!.analysis.static)).toContain("subagent:bbox:main:header");
    expect(ids(graph[1]!.analysis.dynamic)).toContain("subagent:bbox:main:r1");
    expect(ids(graph[1]!.analysis.dynamic)).toContain("subagent:bbox:main:r2");
    expect(ids(graph[1]!.analysis.static)).not.toContain("subagent:bbox:main:r1");
  });

  it("de-dupes a repeated registration to one node", () => {
    const graph = discoverAgents(rootModule, [reviewerModule, bboxModule, bboxModule]);
    expect(graph.filter((n) => n.spec.agentName === "bbox-extractor")).toHaveLength(1);
  });
});

describe("emitCloudflare — a class per level with its OWN childBinding", () => {
  const graph = discoverAgents(rootModule, [reviewerModule, bboxModule]);
  const children: ChildAgentSpec[] = graph
    .slice(1)
    .map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath }));
  const cf = () =>
    emitCloudflare(
      { spec: graph[0]!.spec, componentName: "LayoutAnalyst", componentImport: "../agents/layout-analyst.tsx" },
      children,
      graph[0]!.analysis,
      { runtimeImport: "./runtime" }
    );

  it("emits three Durable Object classes", () => {
    const out = cf().agents;
    expect(out).toContain("class LayoutAnalystDurable");
    expect(out).toContain("class LayoutReviewerDurable");
    expect(out).toContain("class BboxExtractorDurable");
  });

  it("the mid-level class binds ITS OWN child (bbox-extractor), not {}", () => {
    const out = cf().agents;
    const midBlock = out.slice(
      out.indexOf("class LayoutReviewerDurable"),
      out.indexOf("class BboxExtractorDurable")
    );
    expect(midBlock).toContain(`"bbox-extractor": "BBOX_EXTRACTOR",`);
    // the leaf composes nothing → empty binding
    const leafBlock = out.slice(out.indexOf("class BboxExtractorDurable"));
    expect(leafBlock).toContain("protected childBinding = {};");
  });

  it("the root binds ONLY its direct child, not the whole flattened graph", () => {
    const out = cf().agents;
    const rootBlock = out.slice(
      out.indexOf("class LayoutAnalystDurable"),
      out.indexOf("class LayoutReviewerDurable")
    );
    expect(rootBlock).toContain(`"layout-reviewer": "LAYOUT_REVIEWER",`);
    expect(rootBlock).not.toContain("bbox-extractor");
  });

  it("GeneratedEnv and wrangler cover every class", () => {
    const out = cf();
    expect(out.agents).toContain("LAYOUT_ANALYST: DurableObjectNamespace;");
    expect(out.agents).toContain("LAYOUT_REVIEWER: DurableObjectNamespace;");
    expect(out.agents).toContain("BBOX_EXTRACTOR: DurableObjectNamespace;");
    const config = JSON.parse(out.wrangler.replace(/^\s*\/\/.*$/gm, ""));
    const classes = config.durable_objects.bindings.map((b: { class_name: string }) => b.class_name);
    expect(classes).toEqual(["LayoutAnalystDurable", "LayoutReviewerDurable", "BboxExtractorDurable"]);
    expect(config.migrations[0].new_sqlite_classes).toEqual(classes);
  });
});

describe("emitFlue — native subagents at every level, dynamic-only spawnPlan", () => {
  const graph = discoverAgents(rootModule, [reviewerModule, bboxModule]);
  const [rootNode, reviewerNode, bboxNode] = graph;
  const profileImport = (kind: string) => ({
    importPath: `./${kind}.flue.ts`,
    profileExportName: flueProfileExportName(kind),
  });

  it("root defineAgent declares its static nested profile and excludes it from spawnPlan", () => {
    const out = emitFlue({
      spec: rootNode!.spec,
      model: "openrouter/google/gemini-3.1-flash-lite-preview",
      componentName: "LayoutAnalyst",
      componentImport: "../agents/layout-analyst.tsx",
      analysis: rootNode!.analysis,
      childProfiles: rootNode!.directChildren.map(profileImport),
      runtimeImport: "./runtime",
    });
    expect(out).toContain(`import { layout_reviewerProfile } from "./layout-reviewer.flue.ts";`);
    expect(out).toContain("subagents: [layout_reviewerProfile]");
    // review:main is static → excluded from the dynamic residue plan.
    expect(out).toContain(`const STATIC_SUBAGENTS = new Set(["review:main"]);`);
    expect(out).toContain("!STATIC_SUBAGENTS.has(r.name)");
  });

  it("mid-level defineAgentProfile nests its own profile (exactly flue's sketch)", () => {
    const out = emitFlueChild(
      { spec: reviewerNode!.spec, exportName: "LayoutReviewer", importPath: "../agents/layout-reviewer.tsx" },
      400,
      {
        runtimeImport: "./runtime",
        childProfiles: reviewerNode!.directChildren.map(profileImport),
        analysis: reviewerNode!.analysis,
      }
    );
    expect(out).toContain("defineAgentProfile");
    expect(out).toContain(`import { bbox_extractorProfile } from "./bbox-extractor.flue.ts";`);
    expect(out).toContain("subagents: [bbox_extractorProfile]");
    // the dynamic per-region fan-out is the mid-level's spawn residue; the
    // always-on header is static and excluded.
    expect(out).toContain("export function spawnPlan");
    expect(out).toContain(`const STATIC_SUBAGENTS = new Set(["bbox:main:header"]);`);
  });

  it("leaf profile stays a plain task profile (no subagents, no spawnPlan)", () => {
    const out = emitFlueChild(
      { spec: bboxNode!.spec, exportName: "BboxExtractor", importPath: "../agents/bbox-extractor.tsx" },
      400,
      { runtimeImport: "./runtime" }
    );
    expect(out).toContain("defineAgentProfile");
    expect(out).not.toContain("subagents:");
    expect(out).not.toContain("spawnPlan");
  });
});
