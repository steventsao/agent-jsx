import { Agent } from "../../src/agent-class.tsx";
import type { ChessPlayerProps } from "./board.tsx";
import { PlayerPrompt } from "./player-prompt.tsx";

interface PlayerState extends Record<string, unknown> {
  turns: number;
}

/** Model/provider identity is explicit policy; the class name carries no
 * inferred meaning. */
export default class GeminiChessPlayer extends Agent<PlayerState, ChessPlayerProps> {
  static agentName = "gemini-chess-player";
  initialState: PlayerState = { turns: 0 };

  render() {
    return this.define({
      model: "openrouter/google/gemini-2.5-flash",
      displayName: "Gemini",
      description: "Chooses one legal chess move using a Gemini model.",
      prompt: <PlayerPrompt provider="Gemini" turn={this.props.turn} />,
    });
  }
}
