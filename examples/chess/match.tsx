import { composeAgent, result } from "../../src/agent-class.tsx";
import {
  Agent as Player,
  Board,
  initialChessState,
  stateAfterMoves,
  type ChessState,
} from "./board.tsx";
import { ChessMatchAgent, GeminiAgent, OpenAIAgent } from "./players.tsx";

export { initialChessState, stateAfterMoves, type ChessState } from "./board.tsx";

/** Hierarchy and authority exist only here. The render prop exposes the match
 * agent's getters and @callable methods; passing result(handleTurn) is the
 * explicit child-to-parent grant. */
export const ChessMatch = composeAgent(
  <ChessMatchAgent name="match">
    {({ turn, handleTurn }) => {
      if (!turn) return null;
      return (
        <Board turn={turn}>
          <Player
            agentClass={OpenAIAgent}
            turn={turn}
            onTurn={result(handleTurn)}
          />
          <Player
            agentClass={GeminiAgent}
            turn={turn}
            onTurn={result(handleTurn)}
          />
        </Board>
      );
    }}
  </ChessMatchAgent>,
);
