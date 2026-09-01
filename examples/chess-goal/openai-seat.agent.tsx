/**
 * The OpenAI seat — an AUTHORED function component, sealed by its profile.
 *
 * In examples/chess (the old-grammar exhibit) each seat is a class file plus a
 * generated class→boundary companion, and the composition site sprinkles seat
 * identity (`side`) alongside its input. Here the agent is one PascalCase
 * function with ordinary props and a direct JSX return; durable identity
 * (`name`), the model, and initial durable state live in the explicit
 * `profile` beside it — cloudflare/agents style, where model usage is
 * internal. The compiler owns the boundary: ./generated/openai-seat.compiled.tsx
 * re-exports this seat under the SAME public JSX name.
 *
 * The composition site therefore carries ONLY:
 *
 *   <OpenAISeat name={`white:${ply}`} turn={seatTurn} onTurn={result(...)} />
 *
 * instance identity + serializable turn + the one granted capability. No
 * `side`, no `agentClass`, no model id anywhere near the composition.
 */

import { defineAgentProfile } from "../../src/agent-component.tsx";
import { PlayerPrompt } from "../chess/player-prompt.tsx";
import { sampleSeatProps, type ChessSeatProps, type SeatState } from "./seat-contract.ts";

/** Identity, model, and authority stay explicit; only boundary glue is generated. */
export const profile = defineAgentProfile<ChessSeatProps, SeatState>({
  name: "openai-chess-player",
  model: "openrouter/openai/gpt-5-mini",
  displayName: "OpenAI",
  description: "Chooses one legal chess move using an OpenAI model.",
  initialState: { turns: 0 },
  sampleProps: sampleSeatProps,
  capabilities: { onTurn: "result" },
});

/** A normal pure JSX component. The compiler, not this file, makes it a boundary. */
export default function OpenAISeat({ turn }: ChessSeatProps) {
  return <PlayerPrompt provider="OpenAI" turn={turn} />;
}
