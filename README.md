# agent-jsx

> Experimental. The APIs are still changing; use the compatibility suites as
> the source of truth before deploying anything important.

Compose typed agents as JSX. Serializable props are input, function props are
explicit capabilities, `name` is durable identity, and the compiler emits the
Cloudflare Agents or Flue wiring.

## The small example

This is the intended application surface:

```tsx
const turn = turnFor(state);
if (!turn) return null;

const handleTurn: ChessPlayerProps["onTurn"] = (decision) =>
  applyChessTurn(store, decision);

return (
  <Board turn={turn}>
    <Agent agentClass={OpenAIAgent} turn={turn} onTurn={handleTurn} />
    <Agent agentClass={GeminiAgent} turn={turn} onTurn={handleTurn} />
  </Board>
);
```

`Board` selects white or black and injects only `side` plus the stable instance
name. `turn` and `onTurn={handleTurn}` are explicit on each agent. The provider
class selects behavior; it never implies data or authority. Each `agentClass`
remains fully typed, so an incompatible player is rejected by TypeScript.

```tsx
export interface ChessPlayerProps {
  side: "white" | "black";
  turn: ChessTurn;
  onTurn: (decision: ChessDecision | string) => void | Promise<void>;
}

export const OpenAIAgent = agentComponent<ChessPlayerProps, PlayerState>({
  agentName: "openai-chess-player",
  initialState: { turns: 0 },
  sampleProps,
  capabilities: {
    onTurn: { kind: "result" },
  },
  impl: ({ side, turn, onTurn, store }) => (
    <>
      {/* prompt, tools, and tasks owned by this agent */}
    </>
  ),
});
```

The binder is ordinary reusable SDK code, not a chess compiler feature:

```tsx
const chess = createAgentBinder<Omit<BoardProps, "children">, Pick<ChessPlayerProps, "side">>({
  displayName: "Board",
  select: ({ turn }) =>
    turn ? (turn.side === "white" ? 0 : 1) : null,
  bind: ({ turn }) => ({
    name: `${turn!.side}:${turn!.ply}`,
    side: turn!.side,
  }),
});

export const Agent = chess.Agent;
export const Board = chess.Binder;
```

See [examples/chess](examples/chess/) for the full game state, chess.js rules,
OpenAI and Gemini players, generated Flue modules, and a deployable Worker UI.

## The boundary contract

An agent is a typed class produced by `agentComponent`:

```tsx
type WorkerProps = {
  query: string;
  onResult: (answer: Answer) => void;
  lookupPolicy: (name: string) => Promise<Policy>;
};

export const Worker = agentComponent<WorkerProps, WorkerState, Answer>({
  agentName: "worker",
  initialState: { status: "idle" },
  inputSchema: WorkerInputSchema,
  outputSchema: AnswerSchema,
  capabilities: {
    onResult: { kind: "result" },
    lookupPolicy: {
      kind: "method",
      inputSchema: LookupArgumentsSchema,
      outputSchema: PolicySchema,
    },
  },
  impl: ({ query, onResult, lookupPolicy, store, emit }) => {
    // The implementation sees normal typed functions.
    // Generated runtimes turn granted calls into RPC or task results.
    return null;
  },
});
```

The rules are deliberately small:

- Non-function props cross the boundary as serializable child input.
- Every function prop must appear in `capabilities`. There is no `on*`
  naming heuristic and no implicit RPC exposure.
- `callback` is a child-to-parent event, `method` returns a value, and
  `result` receives delegated work output.
- Optional argument and return schemas validate both sides of a call.
- A mandatory `name` identifies the durable instance; `agentName` identifies
  the reusable class/profile.
- A render-prop child is a continuation. The child calls `emit(output)`, the
  parent stores that output, re-renders, and owns the resulting grandchildren.

The chess Worker also binds providers by live class identity:

```ts
const providers = new Map([
  [OpenAIAgent, openAIMove],
  [GeminiAgent, geminiMove],
]);
```

The class reference is private, non-serializable metadata. Cross-runtime
delegation still uses the generated profile/class name, but local code never
needs `if (agent === "openai-chess-player")` dispatch.

## What gets generated

| JSX concept | Cloudflare Agents | Flue |
|---|---|---|
| `agentClass` | typed Agent/Durable Object class | `defineAgentProfile` |
| nested agent | child binding, migration, accessor | parent `subagents` roster |
| stable `name` | child instance identity | task/spawn-plan identity |
| serializable prop | `setProps` input | `session.task` input |
| callback/method prop | explicit generated RPC ACL | awaited task result or generated binding |
| tool slot | native `agentTool(ChildClass, schemas)` | profile alias named by the prop key |
| prompt tree | `getSystemPrompt` / rendered context | profile instructions |

Cloudflare native `agentTool` preserves the child description, display name,
input schema, output schema, structured result, and stable tool-call run
identity. The generated parent exposes only capabilities declared at the JSX
boundary.

Flue resolves subagents by `AgentProfile.name`, so a prop-key tool slot such as
`onCall` becomes a generated alias profile with that exact name. Delegation uses
Flue native `session.task(text, { agent })`; the reactive workflow layer
re-evaluates state and folds explicit result bindings until the tree converges.

This follows the grain of both projects: Cloudflare provides child Durable
Objects, typed RPC, and `agentTool`; Flue provides named profiles, rosters,
tools, and retained child task sessions. agent-jsx supplies the typed
desired-state composition layer above them.

## Secrets and the chess Worker

Provider keys stay in Worker bindings and are never returned to the browser or
stored in JSX props:

```sh
cd compat/chess
bun install
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put GEMINI_API_KEY
bunx wrangler secret put DEMO_ACCESS_TOKEN
bun run deploy
```

The browser sends only the demo access token to the Worker. The Worker reads
OpenRouter/Gemini secrets server-side, validates each move against the legal
move schema and chess.js, then persists game state in a Durable Object. For a
public product, replace the demo token with user authentication and rate
limiting.

## Verify it

```sh
bun install
bun run typecheck
bun test tests

# Real @flue/runtime validators
cd compat/flue && bun run test

# Real Cloudflare Agents inside workerd
cd ../cloudflare && bun run typecheck && bun run test

# Native agents/agentTool execution inside workerd
cd ../think && bun run typecheck && bun run test

# Chess provider and generated Worker checks
cd ../chess && bun run typecheck && bun run test
```

The root suite covers type failures, explicit capability routing, schema
validation, generated ACLs, reactive execution, chess alternation, and
byte-for-byte fixtures. The compatibility suites execute generated code against
the real target packages rather than mocks.

Useful entry points:

- [src/agent-component.tsx](src/agent-component.tsx) — typed agent classes,
  capabilities, and binders.
- [examples/chess/match.tsx](examples/chess/match.tsx) — the tiny Board syntax.
- [src/compile/emit-think.ts](src/compile/emit-think.ts) — native Cloudflare
  `agentTool` emission.
- [src/compile/emit-flue.ts](src/compile/emit-flue.ts) — Flue profiles, aliases,
  tools, and workflows.
- [COMPAT-REPORT.md](COMPAT-REPORT.md) — target limitations and compatibility
  findings.
