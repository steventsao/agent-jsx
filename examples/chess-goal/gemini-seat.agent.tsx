/**
 * The Gemini seat — same authored shape as ./openai-seat.agent.tsx: a
 * PascalCase function component plus an explicit `profile`. Identity, model,
 * and initial state are sealed here; the compiler-owned companion at
 * ./generated/gemini-seat.compiled.tsx exposes the boundary under the same
 * public JSX name.
 */

import { defineAgentProfile } from "../../src/agent-component.tsx";
import { PlayerPrompt } from "../chess/player-prompt.tsx";
import { sampleSeatProps, type ChessSeatProps, type SeatState } from "./seat-contract.ts";

/** Identity, model, and authority stay explicit; only boundary glue is generated. */
export const profile = defineAgentProfile<ChessSeatProps, SeatState>({
  name: "gemini-chess-player",
  model: "openrouter/google/gemini-2.5-flash",
  displayName: "Gemini",
  description: "Chooses one legal chess move using a Gemini model.",
  initialState: { turns: 0 },
  sampleProps: sampleSeatProps,
  capabilities: { onTurn: "result" },
});

/** A normal pure JSX component. The compiler, not this file, makes it a boundary. */
export default function GeminiSeat({ turn }: ChessSeatProps) {
  return <PlayerPrompt provider="Gemini" turn={turn} />;
}
