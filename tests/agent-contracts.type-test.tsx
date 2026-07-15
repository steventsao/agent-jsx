/** Compile-time acceptance tests for Agent and higher-level binders. */

import {
  Agent,
  agentComponent,
  createAgentBinder,
  defineAgentProfile,
  type AgentOutputOf,
} from "../src/agent-component.tsx";

interface Turn extends Record<string, unknown> {
  side: "white" | "black";
}

interface PlayerProps {
  side: "white" | "black";
  turn: Turn;
  onTurn: (decision: { move: string }) => void | Promise<void>;
  lookupOpening?: (fen: string) => string | Promise<string>;
}

const Player = agentComponent<PlayerProps, Record<string, never>, { move: string }>({
  agentName: "typed-player",
  initialState: {},
  capabilities: {
    onTurn: { kind: "result" },
    lookupOpening: { kind: "method" },
  },
  sampleProps: { side: "white", turn: { side: "white" }, onTurn: () => {} },
  sampleOutput: { move: "e2e4" },
  impl: () => null,
});

// Standalone Agent preserves the selected class's full prop contract.
<Agent agentClass={Player} name="white:0" side="white" turn={{ side: "white" }} onTurn={() => {}} />;

// @ts-expect-error onTurn is required by PlayerProps.
<Agent agentClass={Player} name="white:0" side="white" turn={{ side: "white" }} />;

<Agent
  agentClass={Player}
  name="white:0"
  side="white"
  turn={{ side: "white" }}
  onTurn={() => {}}
  // @ts-expect-error lookupOpening's argument and return types are preserved.
  lookupOpening={(fen: number) => fen}
/>;

type PlayerOutput = AgentOutputOf<typeof Player>;
const output: PlayerOutput = { move: "e2e4" };
void output;
// @ts-expect-error output is inferred from agentComponent's O parameter.
const badOutput: PlayerOutput = { move: 42 };
void badOutput;

interface BoardInput extends Record<string, unknown> {
  turn: Turn;
}

// Board supplies only seat identity. Data and capabilities stay visible and
// typed on every Agent declaration.
const chess = createAgentBinder<BoardInput, Pick<PlayerProps, "side">>({
  select: ({ turn }) => (turn.side === "white" ? 0 : 1),
  bind: ({ turn }, index) => ({
    name: `${turn.side}:${index}`,
    side: turn.side,
  }),
});
const Board = chess.Binder;
const Seat = chess.Agent;

<Board turn={{ side: "white" }}>
  <Seat agentClass={Player} turn={{ side: "white" }} onTurn={() => {}} />
  <Seat agentClass={Player} turn={{ side: "white" }} onTurn={() => {}} />
</Board>;

// @ts-expect-error Board injects side only; onTurn remains an explicit grant.
<Seat agentClass={Player} turn={{ side: "white" }} />;

interface WrongPlayerProps {
  side: number;
  turn: { side: number };
  onTurn: (decision: string) => void;
}
const WrongPlayer = agentComponent<WrongPlayerProps, Record<string, never>>({
  agentName: "wrong-player",
  initialState: {},
  capabilities: { onTurn: { kind: "result" } },
  sampleProps: { side: 1, turn: { side: 1 }, onTurn: () => {} },
  impl: () => null,
});

// @ts-expect-error the binder cannot supply WrongPlayer's incompatible props.
<Seat agentClass={WrongPlayer} turn={{ side: 1 }} onTurn={() => {}} />;

interface MissingCapabilityProps {
  done: (value: string) => void;
}
// @ts-expect-error every function prop must have an explicit capability mode.
agentComponent<MissingCapabilityProps, Record<string, never>>({
  agentName: "missing-capability",
  initialState: {},
  sampleProps: { done: () => {} },
  impl: () => null,
});

// @ts-expect-error source profiles also require every function capability.
defineAgentProfile<MissingCapabilityProps, Record<string, never>>({
  name: "missing-profile-capability",
  model: "test/model",
  initialState: {},
  sampleProps: { done: () => {} },
});

// @ts-expect-error source profiles never infer reusable identity.
defineAgentProfile<Record<string, never>, Record<string, never>>({
  model: "test/model",
  initialState: {},
});

// @ts-expect-error source profiles never infer model policy.
defineAgentProfile<Record<string, never>, Record<string, never>>({
  name: "missing-model",
  initialState: {},
});
