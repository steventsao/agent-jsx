import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import {
  applyChessTurn,
  Agent,
  Board,
  initialChessState,
  stateAfterMoves,
  turnFor,
  type ChessPlayerProps,
  type ChessState,
} from "./board.tsx";
import { GeminiAgent, OpenAIAgent } from "./players.tsx";

export { initialChessState, stateAfterMoves, type ChessState } from "./board.tsx";

interface ChessMatchProps extends Record<string, unknown> {}

export const ChessMatch = agentComponent<ChessMatchProps, ChessState>({
  agentName: "chess-match",
  displayName: "Agent JSX Chess",
  description: "Alternates two model agents over a validated chess board.",
  initialState: initialChessState,
  sampleProps: {},
  impl: ({ store }) => {
    const state = useAgentState(store);
    const turn = turnFor(state);
    if (!turn) return null;
    const handleTurn: ChessPlayerProps["onTurn"] = (decision) =>
      applyChessTurn(store, decision);
    return (
      <Board turn={turn}>
        <Agent agentClass={OpenAIAgent} turn={turn} onTurn={handleTurn} />
        <Agent agentClass={GeminiAgent} turn={turn} onTurn={handleTurn} />
      </Board>
    );
  },
});
