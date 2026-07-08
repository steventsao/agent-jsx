/**
 * Runnable, offline, zero-service demo of a 3-LEVEL STATIC hierarchy:
 *
 *   layout-analyst  → layout-reviewer  → bbox-extractor
 *
 * Every level is nested by REFERENCE, unconditionally — that is flue's native
 * shape (`subagents: [profile]` on the agent AND on the mid profile). Here we:
 *
 *   1. discover the graph transitively from the root (the compiler primitive),
 *   2. drive the sim host at every level and print the spawn op log — nesting
 *      IS the spawn topology, so the log is three levels deep,
 *   3. label each spawn static vs dynamic from that level's own analysis,
 *   4. print the flue-native emission the compiler produces from this nesting.
 *
 *   bun examples/layout-review/demo.tsx
 */

import { SimHost } from "../../src/sim-host.ts";
import { createStore } from "../../src/state.ts";
import { evaluateTree } from "../../src/compile/evaluate.ts";
import { collectInfra } from "../../src/tree.ts";
import { discoverAgents, type AgentModule, type AgentNode } from "../../src/compile/graph.ts";
import { LayoutAnalyst, initialLayoutAnalystState } from "./layout-analyst.tsx";
import { LayoutReviewer, type ReviewPage } from "./layout-reviewer.tsx";
import { BboxExtractor } from "../pdf/bbox-extractor.tsx";

const world = { statusAt: () => 200 };

// A page with two detected regions — enough to contrast the always-on header
// extractor (static) against the per-region fan-out (dynamic).
const loadedPage: ReviewPage = {
  id: "p1",
  pdfB64: "stub-pdf-bytes",
  regions: [
    { id: "r1", bbox: { x0: 0, y0: 0.2, x1: 1, y1: 0.5 } },
    { id: "r2", bbox: { x0: 0, y0: 0.5, x1: 1, y1: 0.9 } },
  ],
};

const rootModule: AgentModule = {
  spec: LayoutAnalyst.spec,
  exportName: "LayoutAnalyst",
  importPath: "./layout-analyst.tsx",
  samples: [{ state: initialLayoutAnalystState }, { state: { page: loadedPage, verdict: null } }],
};
const reviewerModule: AgentModule = {
  spec: LayoutReviewer.spec,
  exportName: "LayoutReviewer",
  importPath: "./layout-reviewer.tsx",
  samples: [
    { props: { page: null }, state: { segments: {} } },
    { props: { page: loadedPage }, state: { segments: {} } },
  ],
};
const bboxModule: AgentModule = {
  spec: BboxExtractor.spec,
  exportName: "BboxExtractor",
  importPath: "../pdf/bbox-extractor.tsx",
};

const graph = discoverAgents(rootModule, [reviewerModule, bboxModule]);
const nodeByKind = new Map(graph.map((n) => [n.spec.agentName, n]));
const isStatic = (node: AgentNode, name: string) =>
  node.analysis.static.some((r) => r.kind === "subagent" && r.name === name);

/**
 * Drive one agent instance through the sim host and recurse into every child it
 * spawns. Each level gets its own host — exactly like each level is its own
 * Durable Object under the cloudflare target.
 */
function spawn(
  node: AgentNode,
  props: Record<string, unknown>,
  state: Record<string, unknown>,
  depth: number
): void {
  const host = new SimHost(world);
  const roots = evaluateTree({
    type: node.spec.impl,
    props: { ...props, store: createStore(state) },
  } as never);
  const desired = roots.flatMap((r) => collectInfra(r));
  host.reconcile(desired); // create ops for the whole desired surface

  const pad = "   " + "  ".repeat(depth);
  for (const rec of desired) {
    if (rec.kind === "subagent") {
      const kind = String(rec.config.kind);
      const tag = isStatic(node, rec.name) ? "static " : "dynamic";
      console.log(`${pad}+ spawn  ${kind.padEnd(16)} ${rec.name.padEnd(22)} [${tag}]`);
      const child = nodeByKind.get(kind);
      if (child) {
        const { kind: _kind, ...dataProps } = rec.config;
        spawn(child, { ...(child.spec.sampleProps ?? {}), ...dataProps }, child.spec.initialState, depth + 1);
      }
    } else if (rec.kind === "task") {
      console.log(`${pad}  · work   ${rec.kind.padEnd(16)} ${rec.name}`);
    }
  }
}

console.log("3-LEVEL STATIC HIERARCHY — layout-analyst → layout-reviewer → bbox-extractor\n");

console.log("1. Transitive discovery (each level's DIRECT children):\n");
for (const node of graph) {
  const kids = node.directChildren.length ? node.directChildren.join(", ") : "(leaf)";
  console.log(`   ${node.isRoot ? "root " : "     "}${node.spec.agentName.padEnd(16)} → ${kids}`);
}

console.log("\n2. Sim host spawn op log (nesting IS the spawn topology):\n");
console.log(`   + spawn  ${"layout-analyst".padEnd(16)} ${"(root)".padEnd(22)} [entry]`);
spawn(graph[0]!, {}, { page: loadedPage, verdict: null }, 1);

console.log("\n3. Per-level static/dynamic split (the compile-time capability surface):\n");
for (const node of graph) {
  const s = node.analysis.static.filter((r) => r.kind === "subagent").map((r) => r.name);
  const d = node.analysis.dynamic.filter((r) => r.kind === "subagent").map((r) => r.name);
  if (s.length || d.length) {
    console.log(`   ${node.spec.agentName}:`);
    for (const name of s) console.log(`     static   subagent:${name}`);
    for (const name of d) console.log(`     dynamic  subagent:${name}  (state/prop-gated)`);
  }
}

console.log("\n4. flue-native emission (nesting → subagents, dynamic residue → spawnPlan):\n");
for (const node of graph) {
  const kind = node.isRoot ? "defineAgent       " : "defineAgentProfile";
  const subs = node.directChildren.length ? `subagents: [${node.directChildren.join(", ")}]` : "(leaf profile)";
  const dyn = node.analysis.dynamic.filter((r) => r.kind === "subagent");
  const plan = dyn.length ? `  + spawnPlan(${dyn.map((r) => r.name).join(", ")})` : "";
  console.log(`   ${kind} ${node.spec.agentName.padEnd(16)} ${subs}${plan}`);
}

console.log(
  "\nStatic nesting stays native `subagents:` at every level; only the prop-gated\n" +
    "per-region fan-out becomes spawnPlan residue. No boundary is flattened.\n"
);
