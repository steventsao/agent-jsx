# agent-jsx

> Experimental. The APIs are still changing; use the compatibility suites as
> the source of truth before deploying anything important.

Compose typed agents as JSX. Serializable props are input, function props are
explicit capabilities, `name` is durable identity, and the compiler emits the
Cloudflare Agents or Flue wiring.

## The authoring model

An agent is a hierarchy-free class modeled after `cloudflare/agents`. It owns
durable state, explicitly callable methods, and model context. It does not say
whether it is a parent or child.

```tsx
// openai-chess-player.agent.tsx
export default class OpenAIChessPlayer extends Agent<PlayerState, ChessPlayerProps> {
  static agentName = "openai-chess-player";
  model = "openrouter/openai/gpt-5-mini";
  description = "Chooses one legal chess move using an OpenAI model.";
  initialState = { turns: 0 };

  getPrompt() {
    return <PlayerPrompt provider="OpenAI" turn={this.props.turn} />;
  }

  getTools() {
    return { /* AI SDK-style tools, or declarative <tool> JSX */ };
  }

  getSkills() {
    return [];
  }

  render() {
    return <PlayerStatus turns={this.state.turns} />; // optional UI only
  }
}
```

`render()` is never prompt or control-plane input. Agent context comes only
from `getPrompt()`, `getTools()`, and `getSkills()`. They use their natural
plain forms (prompt strings, tool objects, skill lists), with JSX available
where declarative composition is useful. Identity and model remain explicit;
the compiler never infers them from names such as `OpenAIAgent` or
`GeminiAgent`.

State and callable operations use the same shape as a Cloudflare Agent:

```tsx
export default class ChessMatch extends Agent<ChessState> {
  static agentName = "chess-match";
  model = "openrouter/openai/gpt-5-mini";
  initialState = initialChessState;

  get turn() {
    return turnFor(this.state);
  }

  @callable()
  handleTurn(decision: ChessDecision | string) {
    this.setState((state) => reduceChessTurn(state, decision));
  }
}
```

The compiler generates the tiny `compileAgentClass(...)` companions. The
authored files never call `agentComponent` or declare capability maps.

## Explicit composition

Hierarchy and authority are established separately in ordinary JSX:

```tsx
export const ChessMatch = composeAgent(
  <ChessMatchAgent name="match">
    {({ turn, handleTurn }) => {
      if (!turn) return null;
      return (
        <Board turn={turn}>
          <Player
            agentClass={OpenAIAgent}
            turn={turn}
            onTurn={result(handleTurn)}
          />
          <Player
            agentClass={GeminiAgent}
            turn={turn}
            onTurn={result(handleTurn)}
          />
        </Board>
      );
    }}
  </ChessMatchAgent>,
);
```

The render prop exposes only public getters and `@callable` methods from the
match agent. `result(handleTurn)` is an explicit grant: it binds the selected
player’s result to that callable. Nesting by itself grants no RPC access, and
there is no method-name heuristic. Serializable props remain child input;
function props must be explicitly branded at the composition site.

`Board` is ordinary reusable composition code. It selects the active seat and
injects only `side` plus a stable instance name; the compiler has no chess
special case. See [examples/chess](examples/chess/) for the complete game,
generated Flue modules, and deployable Worker fixture.

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
| authored Agent class | typed Agent/Durable Object class | `defineAgentProfile` |
| nested agent | child binding, migration, accessor | parent `subagents` roster |
| stable `name` | child instance identity | task/spawn-plan identity |
| serializable prop | `setProps` input | `session.task` input |
| passed callable ref | explicit generated RPC ACL | awaited task result or generated binding |
| tool slot | native `agentTool(ChildClass, schemas)` | profile alias named by the prop key |
| prompt tree | `getSystemPrompt` / rendered context | profile instructions |

Cloudflare native `agentTool` preserves the child description, display name,
input schema, output schema, structured result, and stable tool-call run
identity. The generated parent exposes only callable references explicitly
passed at the JSX boundary.

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

- [src/agent-class.tsx](src/agent-class.tsx) — hierarchy-free Agent authoring,
  render-prop bindings, and compiler lowering.
- [src/compile/emit-agent-module.ts](src/compile/emit-agent-module.ts) — emits
  the compiler-owned class-to-boundary companion.
- [src/agent-component.tsx](src/agent-component.tsx) — the low-level boundary,
  capability routing, and reusable binders.
- [examples/chess/match.tsx](examples/chess/match.tsx) — explicit hierarchy and
  callable binding in composition JSX.
- [src/compile/emit-think.ts](src/compile/emit-think.ts) — native Cloudflare
  `agentTool` emission.
- [src/compile/emit-flue.ts](src/compile/emit-flue.ts) — Flue profiles, aliases,
  tools, and workflows.
- [COMPAT-REPORT.md](COMPAT-REPORT.md) — target limitations and compatibility
  findings.
