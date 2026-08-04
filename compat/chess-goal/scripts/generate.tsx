/**
 * Generate the react-free chess-goal worker sources — the SAME pipeline as
 * compat/chess/scripts/generate.tsx, pointed at the goal composition:
 *
 *   1. copy the react-free runtime file set (now including src/goal.ts);
 *   2. copy the authored agent files with imports rewritten onto that runtime
 *      (board + seat agents from examples/chess UNCHANGED; goal-provider from
 *      examples/goal; seats + match from examples/chess-goal);
 *   3. emit class→boundary companions for the two seat classes;
 *   4. emit the Cloudflare Think target with the deployment model resolver.
 *
 * The root is a plain `agentComponent` (no class), so unlike chess there is no
 * root companion to emit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../../src/compile/emit-agent-module.ts";
import { emitThink } from "../../../src/compile/emit-think.ts";
import { discoverAgents, type AgentModule } from "../../../src/compile/graph.ts";
import { copyAgentComponent, emitRuntimeFiles } from "../../../src/compile/runtime-files.ts";
import { ChessGoalMatch, goalStateAfterMoves, initialChessGoalState } from "../../../examples/chess-goal/match.tsx";
import { GeminiAgent, OpenAIAgent } from "../../../examples/chess/players.tsx";

const src = new URL("../src/", import.meta.url);
const agents = new URL("./agents/", src);
const generatedAgents = new URL("./generated/", agents);
const generated = new URL("./generated/", src);
const runtime = new URL("./generated/runtime/", src);

mkdirSync(agents, { recursive: true });
mkdirSync(generatedAgents, { recursive: true });
emitRuntimeFiles(runtime.pathname);

// The seat agents and board come from examples/chess UNCHANGED.
for (const file of [
  "board.tsx",
  "player-prompt.tsx",
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

// The goal layer's provider, rewritten onto the runtime set (which carries
// tree.ts, goal.ts, and compile/evaluate.ts alongside store.ts).
copyAgentComponent(
  new URL("../../../examples/goal/goal-provider.tsx", import.meta.url),
  new URL("goal-provider.tsx", agents).pathname,
  "../generated/runtime",
  {
    'import type { ReactNode } from "react";\n': "",
    ReactNode: "unknown",
    "../../src/compile/evaluate.ts": "../generated/runtime/compile/evaluate.ts",
    "../../src/tree.ts": "../generated/runtime/tree.ts",
    "../../src/goal.ts": "../generated/runtime/goal.ts",
  },
);

// The chess-goal composition itself.
for (const file of ["seats.tsx", "match.tsx"]) {
  copyAgentComponent(
    new URL(`../../../examples/chess-goal/${file}`, import.meta.url),
    new URL(file, agents).pathname,
    "../generated/runtime",
    {
      "../chess/board.tsx": "./board.tsx",
      "../chess/players.tsx": "./players.tsx",
      "../goal/goal-provider.tsx": "./goal-provider.tsx",
    },
  );
}

// Seat barrel: only the two seat classes — the goal root is not a class.
writeFileSync(
  new URL("players.tsx", agents),
  `/** GENERATED BARREL. Authored agents live in the adjacent *.agent.tsx files. */
export { OpenAIAgent } from "./generated/openai-chess-player.compiled.tsx";
export { GeminiAgent } from "./generated/gemini-chess-player.compiled.tsx";
`,
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
  spec: ChessGoalMatch.spec,
  exportName: "ChessGoalMatch",
  importPath: "../agents/match.tsx",
  // One sample per active phase, so BOTH seats are discovered behind the gate.
  samples: [{ state: initialChessGoalState }, { state: goalStateAfterMoves(["e2e4"]) }],
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
    analysis: child.analysis,
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

console.log("generated react-free chess-goal agents + goal runtime + Think target");
