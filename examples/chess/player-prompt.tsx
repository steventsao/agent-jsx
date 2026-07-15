import type { ChessTurn } from "./board.tsx";

export const sampleTurn: ChessTurn = {
  ply: 0,
  side: "white",
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  legalMoves: ["e2e4", "d2d4", "g1f3"],
  history: [],
};

export function PlayerPrompt({ provider, turn }: { provider: string; turn: ChessTurn }) {
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
