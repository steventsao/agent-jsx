/**
 * The chess seats, SEALED at authoring time — `agent()` as the capsule.
 *
 * In examples/chess (the old-grammar exhibit) each seat is a class file plus a
 * generated class→boundary companion, and the composition site sprinkles seat
 * identity (`side`) alongside its input. Here the capsule is one factory call:
 * durable identity (`name`), the model, and initial durable state live INSIDE
 * the component record — cloudflare/agents style, where the class is the
 * binding and model usage is internal.
 *
 * The composition site therefore carries ONLY:
 *
 *   <OpenAISeat name={`white:${ply}`} turn={seatTurn} onTurn={result(...)} />
 *
 * instance identity + serializable turn + the one granted capability. No
 * `side`, no `agentClass`, no model id anywhere near the composition.
 */

import { agent } from "../../src/agent-component.tsx";
import type { ChessDecision, ChessTurn } from "../chess/board.tsx";
import { PlayerPrompt, sampleTurn } from "../chess/player-prompt.tsx";

/** The seat's serializable input: the turn, with the domain's last refusal
 *  folded in as re-prompt context after an illegal move. */
export interface SeatTurn extends ChessTurn {
  lastError: string | null;
}

export interface ChessSeatProps {
  turn: SeatTurn;
  onTurn: (decision: ChessDecision | string) => void | Promise<void>;
}

interface SeatState extends Record<string, unknown> {
  turns: number;
}

const sampleSeatProps: ChessSeatProps = {
  turn: { ...sampleTurn, lastError: null },
  onTurn: () => {},
};

export const OpenAISeat = agent<ChessSeatProps, SeatState>({
  name: "openai-chess-player",
  model: "openrouter/openai/gpt-5-mini",
  state: { turns: 0 },
  displayName: "OpenAI",
  description: "Chooses one legal chess move using an OpenAI model.",
  props: sampleSeatProps,
  capabilities: { onTurn: "result" },
  render: ({ props }) => <PlayerPrompt provider="OpenAI" turn={props.turn} />,
});

export const GeminiSeat = agent<ChessSeatProps, SeatState>({
  name: "gemini-chess-player",
  model: "openrouter/google/gemini-2.5-flash",
  state: { turns: 0 },
  displayName: "Gemini",
  description: "Chooses one legal chess move using a Gemini model.",
  props: sampleSeatProps,
  capabilities: { onTurn: "result" },
  render: ({ props }) => <PlayerPrompt provider="Gemini" turn={props.turn} />,
});
