import { mkdirSync, writeFileSync } from "node:fs";
import { discoverAgents, type AgentModule } from "../../src/compile/graph.ts";
import {
  emitFlue,
  emitFlueChild,
  emitFlueWorkflow,
  flueProfileExportName,
} from "../../src/compile/emit-flue.ts";
import { ChessMatch, initialChessState, stateAfterMoves } from "./match.tsx";
import { GeminiAgent, OpenAIAgent } from "./players.tsx";

const root: AgentModule = {
  spec: ChessMatch.spec,
  exportName: "ChessMatch",
  importPath: "../match.tsx",
  samples: [{ state: initialChessState }, { state: stateAfterMoves(["e2e4"]) }],
};
const registry: AgentModule[] = [
  { spec: OpenAIAgent.spec, exportName: "OpenAIAgent", importPath: "../players.tsx" },
  { spec: GeminiAgent.spec, exportName: "GeminiAgent", importPath: "../players.tsx" },
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
  "chess-match.flue.ts",
  emitFlue({
    spec: rootNode.spec,
    model: "openrouter/openai/gpt-5-mini",
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
    analysis: rootNode.analysis,
    childProfiles,
    runtimeImport: "./runtime",
  }),
);
write(
  "chess-match.workflow.ts",
  emitFlueWorkflow({
    spec: rootNode.spec,
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
    agentModuleImport: "./chess-match.flue.ts",
    runtimeImport: "./runtime",
  }),
);
for (const child of graph.slice(1)) {
  write(
    `${child.spec.agentName}.flue.ts`,
    emitFlueChild(
      { spec: child.spec, exportName: child.exportName, importPath: child.importPath },
      400,
      { runtimeImport: "./runtime", analysis: child.analysis },
    ),
  );
}

console.log(`generated ${graph.length + 1} chess Flue modules`);
