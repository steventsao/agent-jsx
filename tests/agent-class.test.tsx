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
import { emitFlueChild } from "../src/compile/emit-flue.ts";
import { analyzeAgent } from "../src/compile/graph.ts";
import { collectInfra, collectPrompt } from "../src/tree.ts";
import { createStore } from "../src/store.ts";

interface MatchState extends Record<string, unknown> {
  turn: number;
}

class MatchAgent extends Agent<MatchState> {
  static agentName = "class-match";
  model = "test/match-model";
  description = "Owns the match state.";
  initialState: MatchState = { turn: 0 };

  get currentTurn() {
    return this.state.turn;
  }

  @callable()
  handleTurn(value: number) {
    this.setState({ ...this.state, turn: value });
  }

  getPrompt() {
    return <prompt><sys p={10}>Match turn {this.state.turn}</sys></prompt>;
  }

  render() {
    return <div data-ui-only>UI turn {this.state.turn}</div>;
  }
}

interface PlayerProps {
  turn: number;
  onTurn: (turn: number) => void | Promise<void>;
}

interface PlayerState extends Record<string, unknown> {
  calls: number;
}

class PlayerAgent extends Agent<PlayerState, PlayerProps> {
  static agentName = "class-player";
  model = "test/player-model";
  description = "Plays one turn.";
  initialState: PlayerState = { calls: 0 };

  getPrompt() {
    return <prompt><msg p={9}>Play turn {this.props.turn}</msg></prompt>;
  }
}

const Match = compileAgentClass(MatchAgent);
const Player = compileAgentClass(PlayerAgent);

class UtilityAgent extends Agent<{ calls: number }> {
  static agentName = "class-utility";
  model = "test/utility-model";
  initialState = { calls: 0 };

  getPrompt() {
    return "Use the utility tools.";
  }

  getTools() {
    return {
      ping: {
        description: "Return pong.",
        execute: () => "pong",
      },
    };
  }

  getSkills() {
    return ["review"];
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

  it("uses getPrompt for agent context and never evaluates UI render", () => {
    const roots = evaluateComponent(ChessComposition.spec.impl, {
      store: createStore<MatchState>({ turn: 2 }),
      emit: () => {},
    });

    expect(collectPrompt(roots).map((block) => block.text)).toEqual(["Match turn 2"]);
    expect(JSON.stringify(roots)).not.toContain("data-ui-only");
    expect(JSON.stringify(roots)).not.toContain("UI turn");
  });

  it("normalizes plain prompt and tool APIs into declarative context", () => {
    const roots = evaluateComponent(Utility.spec.impl, {
      store: createStore({ calls: 0 }),
      emit: () => {},
    });

    expect(collectPrompt(roots).map((block) => block.text)).toEqual(["Use the utility tools."]);
    expect(Utility.spec.skills).toEqual(["review"]);
    expect(roots.flatMap((root) => collectInfra(root))).toMatchObject([
      { kind: "tool", name: "ping", config: { description: "Return pong." } },
    ]);

    const flue = emitFlueChild({
      spec: Utility.spec,
      exportName: "Utility",
      importPath: "./utility.tsx",
    });
    expect(flue).toContain('import { Utility } from "./utility.tsx";');
    expect(flue).toContain("skills: Utility.spec.skills as never");
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
