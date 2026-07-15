import {
  defineAgentProfile,
  type AgentRenderProps,
} from "../../src/agent-component.tsx";
import type { ChessPlayerProps } from "./board.tsx";
import { PlayerPrompt, sampleTurn } from "./player-prompt.tsx";

interface PlayerState extends Record<string, unknown> {}

/** Identity, model, and authority stay explicit; only boundary glue is generated. */
export const profile = defineAgentProfile<ChessPlayerProps, PlayerState>({
  name: "openai-chess-player",
  model: "openrouter/openai/gpt-5-mini",
  displayName: "OpenAI",
  description: "Chooses one legal chess move using an OpenAI model.",
  initialState: {},
  capabilities: { onTurn: "result" },
  sampleProps: { side: "white", turn: sampleTurn, onTurn: () => {} },
});

/** A normal pure JSX component. The compiler, not this file, makes it a boundary. */
export default function OpenAIAgent(
  { turn }: AgentRenderProps<ChessPlayerProps, PlayerState>
) {
  return <PlayerPrompt provider="OpenAI" turn={turn} />;
}
