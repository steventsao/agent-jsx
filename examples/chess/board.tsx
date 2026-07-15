import type { ReactNode } from "react";
import { Chess } from "chess.js";
import { createAgentBinder } from "../../src/agent-component.tsx";
import type { AgentStore } from "../../src/store.ts";

export type ChessSide = "white" | "black";
export type ChessStatus = "playing" | "check" | "checkmate" | "draw" | "max-plies";

export interface ChessMoveRecord {
  ply: number;
  side: ChessSide;
  uci: string;
  san: string;
  note: string;
}

export interface ChessState extends Record<string, unknown> {
  fen: string;
  history: ChessMoveRecord[];
  status: ChessStatus;
  winner: ChessSide | null;
  maxPlies: number;
  lastError: string | null;
}

export interface ChessTurn extends Record<string, unknown> {
  ply: number;
  side: ChessSide;
  fen: string;
  legalMoves: string[];
  history: ChessMoveRecord[];
}

export interface ChessDecision extends Record<string, unknown> {
  move: string;
  note?: string;
}

const START = new Chess();

export const initialChessState: ChessState = {
  fen: START.fen(),
  history: [],
  status: "playing",
  winner: null,
  maxPlies: 80,
  lastError: null,
};

function sideFor(turn: "w" | "b"): ChessSide {
  return turn === "w" ? "white" : "black";
}

function uci(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

function replay(state: ChessState): Chess {
  const game = new Chess();
  for (const prior of state.history) {
    const move = game.move({
      from: prior.uci.slice(0, 2),
      to: prior.uci.slice(2, 4),
      promotion: prior.uci[4],
    });
    if (!move) throw new Error(`stored chess history is invalid at ${prior.uci}`);
  }
  return game;
}

export function turnFor(state: ChessState): ChessTurn | null {
  if (state.status === "checkmate" || state.status === "draw" || state.status === "max-plies") return null;
  const game = replay(state);
  return {
    ply: state.history.length,
    side: sideFor(game.turn()),
    fen: game.fen(),
    legalMoves: game.moves({ verbose: true }).map(uci),
    history: state.history,
  };
}

function parseDecision(value: unknown): ChessDecision | null {
  if (typeof value === "object" && value !== null && typeof (value as { move?: unknown }).move === "string") {
    return value as ChessDecision;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  try {
    return parseDecision(JSON.parse(text));
  } catch {
    const match = text.match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/i);
    return match ? { move: match[0]!.toLowerCase(), note: text } : null;
  }
}

export function reduceChessTurn(state: ChessState, value: unknown): ChessState {
  const decision = parseDecision(value);
  if (!decision) return { ...state, lastError: "agent returned no parseable UCI move" };

  const game = replay(state);
  const legalMoves = game.moves({ verbose: true }).map(uci);
  const candidate = decision.move.toLowerCase();
  if (!legalMoves.includes(candidate)) {
    return { ...state, lastError: `illegal move ${candidate}; legal moves: ${legalMoves.join(", ")}` };
  }

  const side = sideFor(game.turn());
  const move = game.move({
    from: candidate.slice(0, 2),
    to: candidate.slice(2, 4),
    promotion: candidate[4],
  });
  if (!move) return { ...state, lastError: `illegal move ${candidate}` };

  const history = [
    ...state.history,
    {
      ply: state.history.length,
      side,
      uci: candidate,
      san: move.san,
      note: typeof decision.note === "string" ? decision.note : "",
    },
  ];

  let status: ChessStatus = game.inCheck() ? "check" : "playing";
  let winner: ChessSide | null = null;
  if (game.isCheckmate()) {
    status = "checkmate";
    winner = side;
  } else if (game.isDraw()) {
    status = "draw";
  } else if (history.length >= state.maxPlies) {
    status = "max-plies";
  }

  return { ...state, fen: game.fen(), history, status, winner, lastError: null };
}

export function applyChessTurn(store: AgentStore<ChessState>, value: unknown): void {
  store.set((state) => reduceChessTurn(state, value));
}

export function stateAfterMoves(moves: string[], maxPlies = 80): ChessState {
  let state: ChessState = { ...initialChessState, history: [], maxPlies };
  for (const move of moves) state = reduceChessTurn(state, { move, note: "fixture" });
  return state;
}

export interface ChessPlayerProps {
  side: ChessSide;
  turn: ChessTurn;
  onTurn: (decision: ChessDecision | string) => void | Promise<void>;
}

export interface BoardProps {
  turn: ChessTurn;
  children?: ReactNode;
}

type ChessSeatProps = Pick<ChessPlayerProps, "side">;

/**
 * Bind player children by seat: first child is white, second child is black.
 * It returns a cloned data element with normal props injected, so the generic
 * Agent wrapper and the selected agentComponent disappear into the ordinary
 * compiler pipeline—no chess-specific emitter branch is needed.
 */
const chessBinder = createAgentBinder<Omit<BoardProps, "children">, ChessSeatProps>({
  displayName: "Board",
  select: ({ turn }) => (turn.side === "white" ? 0 : 1),
  bind: ({ turn }) => ({
    name: `${turn.side}:${turn.ply}`,
    side: turn.side,
  }),
});

/** Binder-scoped player descriptor. `turn` and `onTurn` stay explicit at each
 * Agent call site; Board supplies only seat identity and the stable name. */
export const Agent = chessBinder.Agent;
export const Board = chessBinder.Binder;
