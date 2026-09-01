/**
 * The shared seat contract for the chess-goal players: the serializable input
 * (the turn, with the domain's last refusal folded in as re-prompt context
 * after an illegal move), the one granted capability, the durable state shape,
 * and the discovery sample both seat profiles reuse.
 */

import type { ChessDecision, ChessTurn } from "../chess/board.tsx";
import { sampleTurn } from "../chess/player-prompt.tsx";

/** The seat's serializable input: the turn, with the domain's last refusal
 *  folded in as re-prompt context after an illegal move. */
export interface SeatTurn extends ChessTurn {
  lastError: string | null;
}

export interface ChessSeatProps {
  turn: SeatTurn;
  onTurn: (decision: ChessDecision | string) => void | Promise<void>;
}

export interface SeatState extends Record<string, unknown> {
  turns: number;
}

export const sampleSeatProps: ChessSeatProps = {
  turn: { ...sampleTurn, lastError: null },
  onTurn: () => {},
};
