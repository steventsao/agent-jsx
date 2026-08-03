# agent-jsx

**A typed composition language for durable agents.**

> Experimental. The APIs are still changing; use the compatibility suites as
> the source of truth before deploying anything important.

Declare agents as hierarchy-free classes, compose them as JSX, and compile the
result to Cloudflare Agents. Serializable props are input, function props are
explicit capabilities, and `name` is durable instance identity.

[API reference](https://steventsao.github.io/agent-jsx/api/) ·
[Chess example](examples/chess/) ·
[Cloudflare Think target](docs/think-target.md)

## Install

Alpha releases use the `alpha` dist-tag:

```sh
bun add @steventsao/agent-jsx@alpha react@^19
```

Authored `.tsx` files use React's automatic JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

## The small example

This is the intended application surface:

```tsx
export const ChessMatch = composeAgent(
  <ChessMatchAgent name="match">
    {({ turn, handleTurn }) => {
      if (!turn) return null;

      return (
        <Board turn={turn}>
          <Agent
            agentClass={OpenAIAgent}
            turn={turn}
            onTurn={result(handleTurn)}
          />
          <Agent
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

`Board` selects the active seat and injects only `side` plus a stable instance
name. `turn` is explicit input. `result(handleTurn)` is an explicit capability
grant. A provider class selects behavior; it never implies data, authority, or
hierarchy.

The compiler has no chess special case. `Board` is ordinary reusable
composition code, and each `agentClass` stays fully typed.

## Declare an agent

An authored agent owns durable state, callable operations, and one model-facing
definition. It does not declare whether it is a parent or child.

```tsx
import { Agent } from "@steventsao/agent-jsx/agent";
import type { ChessPlayerProps } from "./board.js";
import { PlayerPrompt } from "./player-prompt.js";

interface PlayerState extends Record<string, unknown> {
  turns: number;
}

export default class OpenAIChessPlayer
  extends Agent<PlayerState, ChessPlayerProps> {
  static agentName = "openai-chess-player";
  initialState: PlayerState = { turns: 0 };

  render() {
    return this.define({
      model: "openrouter/openai/gpt-5-mini",
      displayName: "OpenAI",
      description: "Chooses one legal chess move.",
      prompt: <PlayerPrompt provider="OpenAI" turn={this.props.turn} />,
    });
  }
}
```

`render()` is synchronous and returns `this.define(...)`. It declares an agent;
it never renders UI.

| Definition field | Meaning |
|---|---|
| `model` | required explicit model id |
| `displayName`, `description` | model/tool-facing metadata |
| `inputSchema`, `outputSchema` | native child-tool boundary contracts |
| `prompt` | plain text or priority-aware prompt JSX |
| `tools` | an AI SDK tool map or declarative `<tool>` JSX |
| `skills` | structural Cloudflare `SkillSource` values |
| `mcpServers` | named public HTTP endpoints and transports |

The definition can use current `this.props` and `this.state`. Tool objects keep
their schemas, provider metadata, approval policy, and structured results.
Compiling a definition performs no provider or MCP network I/O.

Authored MCP descriptors must not contain credentials. Put authenticated MCP
traffic behind a credential-terminating service; see the
[Think target guide](docs/think-target.md) for runtime resolution and lifecycle
rules.

## State and callable methods

State follows the Cloudflare Agent shape. Only methods marked `@callable()` can
be granted across a composition boundary.

```tsx
import { Agent, callable } from "@steventsao/agent-jsx/agent";

export default class ChessMatch extends Agent<ChessState> {
  static agentName = "chess-match";
  initialState = initialChessState;

  render() {
    return this.define({
      model: "openrouter/openai/gpt-5-mini",
      description: "Alternates two model agents over a chess board.",
    });
  }

  get turn() {
    return turnFor(this.state);
  }

  @callable()
  handleTurn(decision: ChessDecision | string): void {
    this.setState((state) => reduceChessTurn(state, decision));
  }
}
```

The compiler generates the small `compileAgentClass(...)` companion used by
composition JSX. Authored classes do not call `agentComponent` or declare a
separate capability map.

## The boundary contract

The rules are deliberately small:

- Non-function props cross a boundary as serializable child input.
- Function props cross only through an explicit branded grant such as
  `result(callable)`; nesting alone grants nothing.
- `name` identifies a mounted durable instance; `static agentName` identifies
  the reusable agent kind.
- The parent owns hierarchy. An agent definition never names its parent or
  children.
- The compiler never infers model, provider, role, or authority from a class
  name.

Cloudflare's native `agentTool` returns child output to the parent model. It
does not invoke parent-owned callback, method, result, or render-prop
continuation capabilities; the model-driven emitter reports each dropped
capability kind instead of silently pretending it survived.

## Compile for Cloudflare

```ts
import {
  analyzeAgent,
  discoverAgents,
  emitCloudflare,
  emitThink,
} from "@steventsao/agent-jsx/compile/cloudflare";
```

| Target | Use it for |
|---|---|
| `emitThink` | the complete model-facing definition: model, prompts, native tools, skills, MCP, schemas, and child `agentTool` delegation |
| `emitCloudflare` | deterministic desired-infrastructure reconciliation, child props, and callable RPC |

`emitCloudflare` keeps model execution, AI SDK tools, skills, and MCP clients
inert and emits a diagnostic. The complete `render() → this.define(...)`
contract lowers through `emitThink`.

The repository still contains older low-level Flue adapters, but this authored
class contract does not add or claim new Flue compatibility.

## Verify it

```sh
bun install --frozen-lockfile
bun run ci

# Deterministic Cloudflare Agents runtime
cd compat/cloudflare && bun run typecheck && bun run test

# Model-driven Cloudflare Agents + Think runtime
cd ../think && bun run typecheck && bun run test

# Generated chess target
cd ../chess && bun run typecheck && bun run test
```

The compatibility suites execute generated code against the pinned real
Cloudflare packages inside workerd rather than replacing the target runtime with
mocks.

## More

- [examples/chess](examples/chess/) — explicit hierarchy, model turns, and
  thought bubbles.
- [docs/think-target.md](docs/think-target.md) — model resolution, tools,
  skills, MCP, schemas, and target diagnostics.
- [docs/cloudflare-adapter.md](docs/cloudflare-adapter.md) — deterministic
  reconcile-mode mapping.
- [COMPAT.md](COMPAT.md) and [COMPAT-REPORT.md](COMPAT-REPORT.md) — compatibility
  contracts and real-runtime findings.
- [CONTRIBUTING.md](CONTRIBUTING.md) — package checks and Changesets releases.
