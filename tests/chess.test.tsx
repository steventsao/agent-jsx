/**
 * Acceptance contract for the small chess authoring surface:
 *
 *   <Board turn={turn}>
 *     <Agent agentClass={OpenAIAgent} turn={turn} onTurn={handleTurn} />
 *     <Agent agentClass={GeminiAgent} turn={turn} onTurn={handleTurn} />
 *   </Board>
 *
 * Board binds the active player by child order (white, black), injects the
 * serializable turn prop, and exposes onTurn as the generated callback glue.
 */

import { describe, expect, it } from "bun:test";
import { collectInfra } from "../src/tree.ts";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/store.ts";
import { evaluateComponent } from "../src/compile/evaluate.ts";
import { discoverAgents, type AgentModule } from "../src/compile/graph.ts";
import { emitFlue, emitFlueChild, emitFlueWorkflow, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { runReactiveStep, runReactiveWorkflow } from "../src/workflow-executor.ts";
import {
  ChessMatch,
  initialChessState,
  stateAfterMoves,
  type ChessState,
} from "../examples/chess/match.tsx";
import { GeminiAgent, OpenAIAgent } from "../examples/chess/players.tsx";

const rootModule = (states: ChessState[] = [initialChessState]): AgentModule => ({
  spec: ChessMatch.spec,
  exportName: "ChessMatch",
  importPath: "../match.tsx",
  samples: states.map((state) => ({ state })),
});

const playerModules: AgentModule[] = [
  { spec: OpenAIAgent.spec, exportName: "OpenAIAgent", importPath: "../players.tsx" },
  { spec: GeminiAgent.spec, exportName: "GeminiAgent", importPath: "../players.tsx" },
];

describe("chess JSX bindings", () => {
  it("binds the first Agent as white with turn data down and onTurn back", () => {
    const roots = evaluateComponent(ChessMatch.spec.impl, {
      store: createStore(initialChessState),
      emit: () => {},
    });
    const records = roots.flatMap((root) => collectInfra(root));
    const player = records.find((record) => record.kind === "subagent");

    expect(player?.name).toBe("white:0");
    expect(player?.config.kind).toBe("openai-chess-player");
    expect(player?.target).toBe(OpenAIAgent);
    expect(player?.config.turn).toMatchObject({ side: "white", ply: 0 });
    expect((player?.config.turn as { legalMoves: string[] }).legalMoves).toContain("e2e4");
    expect(player?.handlers.onTurn).toBeFunction();
  });

  it("keeps the same Board binding under the live React reconciler", () => {
    const host = new SimHost({ statusAt: () => 200 });
    const mounted = mountAgent(
      <ChessMatch.spec.impl store={createStore(initialChessState)} />,
      host,
      { quiet: true },
    );
    const player = [...host.liveRecords.values()].find((record) => record.kind === "subagent");

    expect(player?.name).toBe("white:0");
    expect(player?.config.kind).toBe("openai-chess-player");
    mounted.unmount();
  });

  it("discovers both provider agents when analysis samples both turns", () => {
    const afterE4 = stateAfterMoves(["e2e4"]);
    const graph = discoverAgents(rootModule([initialChessState, afterE4]), playerModules);

    expect(graph.map((node) => node.spec.agentName)).toEqual([
      "chess-match",
      "openai-chess-player",
      "gemini-chess-player",
    ]);
    expect(graph[0]?.directChildren).toEqual(["openai-chess-player", "gemini-chess-player"]);
  });
});

describe("chess reactive execution", () => {
  it("alternates agents and folds legal model moves through onTurn", async () => {
    const script = ["e2e4", "e7e5", "g1f3", "b8c6"];
    const calls: string[] = [];
    const result = await runReactiveWorkflow({
      component: ChessMatch.spec.impl,
      props: {},
      initialState: { ...initialChessState, maxPlies: script.length },
      delegate: (descriptor) => {
        expect(descriptor.target).toBe(
          calls.length % 2 === 0 ? OpenAIAgent : GeminiAgent,
        );
        calls.push(descriptor.agent);
        return JSON.stringify({ move: script[calls.length - 1], note: "test move" });
      },
    });

    expect(calls).toEqual([
      "openai-chess-player",
      "gemini-chess-player",
      "openai-chess-player",
      "gemini-chess-player",
    ]);
    expect(result.delegated).toEqual(["white:0", "black:1", "white:2", "black:3"]);
    expect(result.state.history.map((move) => move.uci)).toEqual(script);
    expect(result.state.status).toBe("max-plies");
  });

  it("runs exactly one generated boundary for an interactive Worker turn", async () => {
    const first = await runReactiveStep({
      component: ChessMatch.spec.impl,
      props: {},
      initialState: initialChessState,
      delegate: () => ({ move: "e2e4", note: "claims the center" }),
    });

    expect(first.descriptor).toMatchObject({ stableId: "white:0", agent: "openai-chess-player" });
    expect(first.state.history.map((move) => move.uci)).toEqual(["e2e4"]);

    const second = await runReactiveStep({
      component: ChessMatch.spec.impl,
      props: {},
      initialState: first.state,
      delegate: () => ({ move: "e7e5", note: "mirrors the center" }),
    });
    expect(second.descriptor).toMatchObject({ stableId: "black:1", agent: "gemini-chess-player" });
    expect(second.state.history.map((move) => move.uci)).toEqual(["e2e4", "e7e5"]);
  });

  it("rejects an illegal model move without corrupting the board", async () => {
    const result = await runReactiveStep({
      component: ChessMatch.spec.impl,
      props: {},
      initialState: initialChessState,
      delegate: () => ({ move: "e2e5", note: "illegal" }),
    });

    expect(result.state.fen).toBe(initialChessState.fen);
    expect(result.state.history).toEqual([]);
    expect(result.state.lastError).toContain("illegal move");
  });
});

describe("chess Flue target", () => {
  const afterE4 = stateAfterMoves(["e2e4"]);
  const graph = discoverAgents(rootModule([initialChessState, afterE4]), playerModules);
  const root = graph[0]!;
  const profileImports = root.directChildren.map((kind) => ({
    importPath: `./${kind}.flue.ts`,
    profileExportName: flueProfileExportName(kind),
  }));

  it("emits both model profiles as the root binding table", () => {
    const output = emitFlue({
      spec: root.spec,
      model: "openrouter/openai/gpt-5-mini",
      componentName: "ChessMatch",
      componentImport: "../match.tsx",
      analysis: root.analysis,
      childProfiles: profileImports,
      runtimeImport: "./runtime",
    });

    expect(output).toContain("subagents: [openai_chess_playerProfile, gemini_chess_playerProfile]");
    expect(output).toContain("stableId: r.name");
    expect(output).toContain("input,");
  });

  it("emits provider-specific player instructions", () => {
    const openai = emitFlueChild(
      { spec: OpenAIAgent.spec, exportName: "OpenAIAgent", importPath: "../players.tsx" },
      400,
      { runtimeImport: "./runtime" },
    );
    const gemini = emitFlueChild(
      { spec: GeminiAgent.spec, exportName: "GeminiAgent", importPath: "../players.tsx" },
      400,
      { runtimeImport: "./runtime" },
    );

    expect(openai).toContain('name: "openai-chess-player"');
    expect(openai).toContain("Return one legal move");
    expect(gemini).toContain('name: "gemini-chess-player"');
    expect(gemini).toContain("Return one legal move");
  });

  it("generates domain-neutral task glue for each turn", () => {
    const output = emitFlueWorkflow({
      spec: root.spec,
      componentName: "ChessMatch",
      componentImport: "../match.tsx",
      agentModuleImport: "./chess-match.flue.ts",
      runtimeImport: "./runtime",
    });

    expect(output).toContain('Run "${descriptor.stableId}" with the "${descriptor.agent}" agent.');
    expect(output).not.toContain("Investigate");
    expect(output).toContain('import chess_matchAgent from "./chess-match.flue.ts";');
    expect(output).not.toContain("chess-matchAgent");
  });
});
