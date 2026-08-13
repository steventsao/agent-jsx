/**
 * Compile the chess-goal example through the SAME pipeline as examples/chess:
 * discovery over sample states (one per active phase, so both seats are
 * reachable), Flue modules for the root and each seat, and the Cloudflare
 * Think target. The root is a plain `agentComponent` and the seats are sealed
 * `agent()` components (./players.tsx), so unlike chess there are no
 * class→boundary companions to emit anywhere.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { emitThink } from "../../src/compile/emit-think.ts";
import { discoverAgents, type AgentModule } from "../../src/compile/graph.ts";
import {
  emitFlue,
  emitFlueChild,
  emitFlueWorkflow,
  flueProfileExportName,
} from "../../src/compile/emit-flue.ts";
import { ChessGoalMatch, goalStateAfterMoves, initialChessGoalState } from "./match.tsx";
import { GeminiSeat, OpenAISeat } from "./players.tsx";

const root: AgentModule = {
  spec: ChessGoalMatch.spec,
  exportName: "ChessGoalMatch",
  importPath: "../match.tsx",
  samples: [{ state: initialChessGoalState }, { state: goalStateAfterMoves(["e2e4"]) }],
};
const registry: AgentModule[] = [
  { spec: OpenAISeat.spec, exportName: "OpenAISeat", importPath: "../players.tsx" },
  { spec: GeminiSeat.spec, exportName: "GeminiSeat", importPath: "../players.tsx" },
];
const graph = discoverAgents(root, registry);
const rootNode = graph[0]!;
const childProfiles = rootNode.directChildren.map((kind) => ({
  importPath: `./${kind}.flue.ts`,
  profileExportName: flueProfileExportName(kind),
}));

const output = new URL("./generated/", import.meta.url);
mkdirSync(output, { recursive: true });
const write = (name: string, source: string) => writeFileSync(new URL(name, output), source);

write(
  "chess-goal-match.flue.ts",
  emitFlue({
    spec: rootNode.spec,
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
    analysis: rootNode.analysis,
    childProfiles,
    runtimeImport: "./runtime",
  }),
);
write(
  "chess-goal-match.workflow.ts",
  emitFlueWorkflow({
    spec: rootNode.spec,
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
    agentModuleImport: "./chess-goal-match.flue.ts",
    runtimeImport: "./runtime",
  }),
);
for (const child of graph.slice(1)) {
  write(
    `${child.spec.agentName}.flue.ts`,
    emitFlueChild(
      {
        spec: child.spec,
        exportName: child.exportName,
        importPath: child.importPath,
        sampleProps: child.samples?.[0]?.props,
      },
      400,
      { runtimeImport: "./runtime", analysis: child.analysis },
    ),
  );
}

const think = emitThink(
  {
    spec: rootNode.spec,
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
  },
  graph.slice(1).map((child) => ({
    spec: child.spec,
    exportName: child.exportName,
    importPath: child.importPath,
    sampleProps: child.samples?.[0]?.props,
    analysis: child.analysis,
  })),
  rootNode.analysis,
  { runtimeImport: "./runtime" },
);
write("chess-goal-match.think.ts", think.agents);
write("chess-goal-match.think.wrangler.jsonc", think.wrangler);

console.log(`generated ${graph.length + 1} chess-goal Flue modules + Think target`);
