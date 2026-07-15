import { Agent, callable } from "../../src/agent-class.tsx";
import {
  initialChessState,
  reduceChessTurn,
  turnFor,
  type ChessDecision,
  type ChessState,
} from "./board.tsx";

/** Owns game state and public operations, but assumes no parent or children. */
export default class ChessMatchAgent extends Agent<ChessState> {
  static agentName = "chess-match";
  model = "openrouter/openai/gpt-5-mini";
  displayName = "Agent JSX Chess";
  description = "Alternates two model agents over a validated chess board.";
  initialState: ChessState = initialChessState;

  get turn() {
    return turnFor(this.state);
  }

  @callable()
  handleTurn(decision: ChessDecision | string): void {
    this.setState((state) => reduceChessTurn(state, decision));
  }
}
