import { mkdirSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../../src/compile/emit-agent-module.ts";
import { copyAgentComponent, emitRuntimeFiles } from "../../../src/compile/runtime-files.ts";

const src = new URL("../src/", import.meta.url);
const agents = new URL("./agents/", src);
const generatedAgents = new URL("./generated/", agents);
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

console.log("generated react-free chess agents + boundary companions + runtime");
