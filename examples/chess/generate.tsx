import { mkdirSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../src/compile/emit-agent-module.ts";
import { emitThink } from "../../src/compile/emit-think.ts";
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
  "chess-match.compiled.tsx",
  emitAgentModule({
    sourceImport: "../chess-match.agent.tsx",
    exportName: "ChessMatchAgent",
    runtimeImport: "../../../src/agent-class.tsx",
  }),
);
write(
  "openai-chess-player.compiled.tsx",
  emitAgentModule({
    sourceImport: "../openai-chess-player.agent.tsx",
    exportName: "OpenAIAgent",
    runtimeImport: "../../../src/agent-class.tsx",
  }),
);
write(
  "gemini-chess-player.compiled.tsx",
  emitAgentModule({
    sourceImport: "../gemini-chess-player.agent.tsx",
    exportName: "GeminiAgent",
    runtimeImport: "../../../src/agent-class.tsx",
  }),
);

write(
  "chess-match.flue.ts",
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
  })),
  rootNode.analysis,
  { runtimeImport: "./runtime" },
);
write("chess-match.think.ts", think.agents);
write("chess-match.think.wrangler.jsonc", think.wrangler);

console.log(`generated 3 agent boundary companions + ${graph.length + 1} chess Flue modules + Think target`);
