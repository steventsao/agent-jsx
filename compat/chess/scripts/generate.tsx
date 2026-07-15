import { mkdirSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../../src/compile/emit-agent-module.ts";
import { emitThink } from "../../../src/compile/emit-think.ts";
import { discoverAgents, type AgentModule } from "../../../src/compile/graph.ts";
import { copyAgentComponent, emitRuntimeFiles } from "../../../src/compile/runtime-files.ts";
import { ChessMatch, initialChessState, stateAfterMoves } from "../../../examples/chess/match.tsx";
import { GeminiAgent, OpenAIAgent } from "../../../examples/chess/players.tsx";

const src = new URL("../src/", import.meta.url);
const agents = new URL("./agents/", src);
const generatedAgents = new URL("./generated/", agents);
const generated = new URL("./generated/", src);
const runtime = new URL("./generated/runtime/", src);

mkdirSync(agents, { recursive: true });
mkdirSync(generatedAgents, { recursive: true });
emitRuntimeFiles(runtime.pathname);

for (const file of [
  "board.tsx",
  "players.tsx",
  "match.tsx",
  "player-prompt.tsx",
  "chess-match.agent.tsx",
  "openai-chess-player.agent.tsx",
  "gemini-chess-player.agent.tsx",
]) {
  copyAgentComponent(
    new URL(`../../../examples/chess/${file}`, import.meta.url),
    new URL(file, agents).pathname,
    "../generated/runtime",
    file === "board.tsx"
      ? { 'import type { ReactNode } from "react";\n': "", ReactNode: "unknown" }
      : {},
  );
}

writeFileSync(
  new URL("chess-match.compiled.tsx", generatedAgents),
  emitAgentModule({
    sourceImport: "../chess-match.agent.tsx",
    exportName: "ChessMatchAgent",
    runtimeImport: "../../generated/runtime/agent-class.tsx",
  }),
);
writeFileSync(
  new URL("openai-chess-player.compiled.tsx", generatedAgents),
  emitAgentModule({
    sourceImport: "../openai-chess-player.agent.tsx",
    exportName: "OpenAIAgent",
    runtimeImport: "../../generated/runtime/agent-class.tsx",
  }),
);
writeFileSync(
  new URL("gemini-chess-player.compiled.tsx", generatedAgents),
  emitAgentModule({
    sourceImport: "../gemini-chess-player.agent.tsx",
    exportName: "GeminiAgent",
    runtimeImport: "../../generated/runtime/agent-class.tsx",
  }),
);

const root: AgentModule = {
  spec: ChessMatch.spec,
  exportName: "ChessMatch",
  importPath: "../agents/match.tsx",
  samples: [{ state: initialChessState }, { state: stateAfterMoves(["e2e4"]) }],
};
const graph = discoverAgents(root, [
  { spec: OpenAIAgent.spec, exportName: "OpenAIAgent", importPath: "../agents/players.tsx" },
  { spec: GeminiAgent.spec, exportName: "GeminiAgent", importPath: "../agents/players.tsx" },
]);
const rootNode = graph[0]!;
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
  {
    runtimeImport: "./runtime",
    modelResolver: {
      importPath: "../model-runtime.ts",
      exportName: "resolveChessModel",
    },
  },
);
writeFileSync(new URL("think.cloudflare.ts", generated), think.agents);
writeFileSync(new URL("think.wrangler.jsonc", generated), think.wrangler);

console.log("generated react-free chess agents + boundary companions + Think target + runtime");
