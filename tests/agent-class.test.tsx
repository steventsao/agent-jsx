import { describe, expect, it } from "bun:test";
import {
  Agent,
  callable,
  compileAgentClass,
  composeAgent,
  result,
} from "../src/agent-class.tsx";
import { evaluateComponent } from "../src/compile/evaluate.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { analyzeAgent } from "../src/compile/graph.ts";
import { collectInfra, collectPrompt } from "../src/tree.ts";
import type { AgentSkillSource } from "../src/types.ts";
import { createStore } from "../src/store.ts";

interface MatchState extends Record<string, unknown> {
  turn: number;
}

class MatchAgent extends Agent<MatchState> {
  static agentName = "class-match";
  initialState: MatchState = { turn: 0 };

  get currentTurn() {
    return this.state.turn;
  }

  @callable()
  handleTurn(value: number) {
    this.setState({ ...this.state, turn: value });
  }

  render() {
    return this.define({
      model: "test/match-model",
      description: "Owns the match state.",
      prompt: <prompt><sys p={10}>Match turn {this.state.turn}</sys></prompt>,
    });
  }
}

interface PlayerProps {
  turn: number;
  onTurn: (turn: number) => void | Promise<void>;
}

interface PlayerState extends Record<string, unknown> {
  calls: number;
}

const reviewSkill = {
  id: "review",
  fingerprint: "review-v1",
  async list() { return []; },
  async load() { return null; },
} satisfies AgentSkillSource;

class PlayerAgent extends Agent<PlayerState, PlayerProps> {
  static agentName = "class-player";
  initialState: PlayerState = { calls: 0 };

  render() {
    return this.define({
      model: "test/player-model",
      description: "Plays one turn.",
      prompt: <prompt><msg p={9}>Play turn {this.props.turn}</msg></prompt>,
    });
  }
}

const Match = compileAgentClass(MatchAgent);
const Player = compileAgentClass(PlayerAgent);

class UtilityAgent extends Agent<{ calls: number }> {
  static agentName = "class-utility";
  initialState = { calls: 0 };

  render() {
    return this.define({
      model: "test/utility-model",
      prompt: "Use the utility tools.",
      tools: {
        ping: {
          description: "Return pong.",
          execute: () => "pong",
        },
      },
      skills: [reviewSkill],
    });
  }
}

const Utility = compileAgentClass(UtilityAgent);

const ChessComposition = composeAgent(
  <Match name="match">
    {({ currentTurn, handleTurn }) => (
      <Player
        name={`player:${currentTurn}`}
        turn={currentTurn}
        onTurn={result(handleTurn)}
      />
    )}
  </Match>,
);

describe("class-authored agents", () => {
  it("uses a render prop for explicit state/callable binding", async () => {
    const store = createStore<MatchState>({ turn: 0 });
    const roots = evaluateComponent(ChessComposition.spec.impl, { store, emit: () => {} });
    const records = roots.flatMap((root) => collectInfra(root));
    const player = records.find((record) => record.kind === "subagent");

    expect(player).toMatchObject({
      name: "player:0",
      config: { kind: "class-player", turn: 0 },
      bindings: { onTurn: { kind: "result" } },
    });

    await player?.handlers.onTurn?.(3);
    expect(store.get().turn).toBe(3);
  });

  it("uses render for agent context", () => {
    const roots = evaluateComponent(ChessComposition.spec.impl, {
      store: createStore<MatchState>({ turn: 2 }),
      emit: () => {},
    });

    expect(collectPrompt(roots).map((block) => block.text)).toEqual(["Match turn 2"]);
  });

  it("keeps plain prompts and AI SDK tool maps in the rendered definition", () => {
    const store = createStore({ calls: 0 });
    const roots = evaluateComponent(Utility.spec.impl, {
      store,
      emit: () => {},
    });
    const definition = Utility.spec.resolveDefinition!({}, store);

    expect(collectPrompt(roots).map((block) => block.text)).toEqual(["Use the utility tools."]);
    expect(Utility.spec.skills).toEqual([reviewSkill]);
    expect(Object.keys(definition.tools)).toEqual(["ping"]);
  });

  it("emits authored callable methods on the generated Cloudflare class", () => {
    const analysis = analyzeAgent({
      spec: ChessComposition.spec,
      exportName: "ChessComposition",
      importPath: "./match.tsx",
    });
    const output = emitCloudflare(
      {
        spec: ChessComposition.spec,
        componentName: "ChessComposition",
        componentImport: "./match.tsx",
      },
      [{ spec: Player.spec, exportName: "Player", importPath: "./player.tsx" }],
      analysis,
    ).agents;

    expect(output).toContain('import { Agent, callable, getAgentByName } from "agents";');
    expect(output).toContain("@callable()\n  async handleTurn(...args: unknown[])");
    expect(output).toContain('this.invokeAuthoredCallable(ChessComposition.spec, "handleTurn", args)');
  });
});
