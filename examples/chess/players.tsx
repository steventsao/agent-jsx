import { agentComponent } from "../../src/agent-component.tsx";
import type { ChessPlayerProps, ChessTurn } from "./board.tsx";

interface PlayerState extends Record<string, unknown> {}

const initialPlayerState: PlayerState = {};
const sampleTurn: ChessTurn = {
  ply: 0,
  side: "white",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  legalMoves: ["e2e4", "d2d4", "g1f3"],
  history: [],
};

function PlayerPrompt({ provider, turn }: { provider: string; turn: ChessTurn }) {
  return (
    <prompt>
      <sys p={10}>
        You are the {provider} chess player. Return one legal move as JSON: {`{"move":"e2e4","note":"short reason"}`}.
        The move must be UCI notation and must appear in legalMoves. Do not add prose outside the JSON.
      </sys>
      <msg p={9}>
        Side: {turn.side}. Ply: {turn.ply}. FEN: {turn.fen}. legalMoves: {turn.legalMoves.join(", ")}.
      </msg>
    </prompt>
  );
}

export const OpenAIAgent = agentComponent<ChessPlayerProps, PlayerState>({
  agentName: "openai-chess-player",
  displayName: "OpenAI",
  description: "Chooses one legal chess move using an OpenAI model.",
  initialState: initialPlayerState,
  capabilities: { onTurn: { kind: "result" } },
  sampleProps: { side: "white", turn: sampleTurn, onTurn: () => {} },
  impl: ({ turn }) => <PlayerPrompt provider="OpenAI" turn={turn} />,
});

export const GeminiAgent = agentComponent<ChessPlayerProps, PlayerState>({
  agentName: "gemini-chess-player",
  displayName: "Gemini",
  description: "Chooses one legal chess move using a Gemini model.",
  initialState: initialPlayerState,
  capabilities: { onTurn: { kind: "result" } },
  sampleProps: { side: "white", turn: sampleTurn, onTurn: () => {} },
  impl: ({ turn }) => <PlayerPrompt provider="Gemini" turn={turn} />,
});
