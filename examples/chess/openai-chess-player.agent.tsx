import { Agent } from "../../src/agent-class.tsx";
import type { ChessPlayerProps } from "./board.tsx";
import { PlayerPrompt } from "./player-prompt.tsx";

interface PlayerState extends Record<string, unknown> {
  turns: number;
}

/** A hierarchy-free agent definition. Composition decides where it runs and
 * which callable references it receives. */
export default class OpenAIChessPlayer extends Agent<PlayerState, ChessPlayerProps> {
  static agentName = "openai-chess-player";
  model = "openrouter/openai/gpt-5-mini";
  displayName = "OpenAI";
  description = "Chooses one legal chess move using an OpenAI model.";
  initialState: PlayerState = { turns: 0 };

  getPrompt() {
    return <PlayerPrompt provider="OpenAI" turn={this.props.turn} />;
  }
}
