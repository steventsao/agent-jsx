# agent-jsx

**A typed composition language for durable agents.**

> Experimental. The APIs are still changing; use the compatibility suites as
> the source of truth before deploying anything important.

Compose typed agents as JSX. Serializable props are input, function props are
explicit capabilities, `name` is durable identity, and the compiler emits the
Cloudflare Agents wiring plus the project's existing legacy Flue adapters.

API reference: <https://steventsao.github.io/agent-jsx/api/>

## Quick start

Alpha releases are published under the `alpha` dist-tag:

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

Import authored agents from `@steventsao/agent-jsx/agent`. Cloudflare compiler
targets are public from one explicit subpath:

```ts
import {
  analyzeAgent,
  discoverAgents,
  emitCloudflare,
  emitThink,
} from "@steventsao/agent-jsx/compile/cloudflare";
```

The JSX-runtime subpath exports remain documented in `package.json`.

## The mental model

agent-jsx keeps three decisions separate:

| Surface | Owns | Does not own |
|---|---|---|
| agent class | durable state, one model-facing definition, callable methods | parent/child placement or UI |
| composition JSX | hierarchy, serializable input, explicit capability grants | provider inference or runtime glue |
| target emitter | Cloudflare reconcile or model-driven integration; legacy Flue adapters | application policy |

The required class `render()` returns that definition through
`this.define(...)`: model and descriptive metadata, input/output schemas,
prompt, tools, skills, and remote MCP dependencies live together as one
declarative value. It is model-facing configuration, never a UI renderer.
Keeping definition separate from composition prevents hierarchy or authority
from hiding in model names and runtime glue.

The complete definition currently lowers through the model-driven Cloudflare
target (`emitThink`). The deterministic Cloudflare reconcile target keeps its
existing desired-infrastructure behavior and reports model execution, AI SDK
tools, skills, and MCP clients as inert. The Flue emitters remain legacy
low-level adapters; this class-definition contract does not add new Flue
compatibility.

## The authoring model

An agent is a hierarchy-free class modeled after `cloudflare/agents`. It owns
durable state, explicitly callable methods, and model context. It does not say
whether it is a parent or child.

```tsx
// openai-chess-player.agent.tsx
import { Agent } from "@steventsao/agent-jsx/agent";
import type { ChessPlayerProps } from "./board.js";
import { PlayerPrompt } from "./player-prompt.js";

interface PlayerState extends Record<string, unknown> {
  turns: number;
}

export default class OpenAIChessPlayer extends Agent<PlayerState, ChessPlayerProps> {
  static agentName = "openai-chess-player";
  initialState: PlayerState = { turns: 0 };

  render() {
    return this.define({
      model: "openrouter/openai/gpt-5-mini",
      displayName: "OpenAI",
      description: "Chooses one legal chess move using an OpenAI model.",
      prompt: <PlayerPrompt provider="OpenAI" turn={this.props.turn} />,
    });
  }
}
```

`render()` is the sole authored definition surface. `this.define(...)` accepts
description/display metadata, input and output schemas for native child-tool
boundaries, a prompt string or priority-aware prompt JSX, an AI SDK-style tool
map or declarative tool JSX, structural Cloudflare `SkillSource` values, and
named MCP servers with an HTTP URL plus optional transport alongside the
required model id. The definition is synchronous and inert: compiling it does
not connect to providers or MCP servers. Individual AI SDK tool objects and all
of their metadata remain intact; the surrounding tool map is re-derived from
the current definition whenever Think asks for tools. The Bun-driven emitter
can load custom/importable `SkillSource` values and
`skills.fromManifest(...)`; it cannot currently load Vite-only `agents:skills`
imports or env-bound `skills.r2(...)` sources.

Authored MCP descriptors never contain credentials. A deployment-owned
`mcpResolver` may select a public URL, transport, OAuth callback settings, and a
non-secret `configRevision`, but it must not return authentication headers:
`agents@0.20.1` persists MCP transport options. Put bearer-secret injection in
a credential-terminating proxy or service instead. Callback hosts are validated
as HTTP(S) origins, callback paths as plain absolute paths, and credential-like
query keys are rejected. The compiler never infers
model, provider, role, or hierarchy from names such as `OpenAIAgent` or
`GeminiAgent`.

State and callable operations use the same shape as a Cloudflare Agent:

```tsx
// chess-match.agent.tsx
import { Agent, callable } from "@steventsao/agent-jsx/agent";
import {
  initialChessState,
  reduceChessTurn,
  turnFor,
  type ChessDecision,
  type ChessState,
} from "./board.js";

export default class ChessMatchAgent extends Agent<ChessState> {
  static agentName = "chess-match";
  initialState: ChessState = initialChessState;

  render() {
    return this.define({
      model: "openrouter/openai/gpt-5-mini",
      displayName: "Agent JSX Chess",
      description: "Alternates two model agents over a validated chess board.",
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

The compiler generates the tiny `compileAgentClass(...)` companions. The
authored files never call `agentComponent` or declare capability maps.

## Explicit composition

Hierarchy and authority are established separately in ordinary JSX:

```tsx
// match.tsx
import { composeAgent, result } from "@steventsao/agent-jsx/agent";
import { Agent as Player, Board } from "./board.js";
import { ChessMatchAgent, GeminiAgent, OpenAIAgent } from "./players.js";

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

`ChessMatchAgent`, `OpenAIAgent`, and `GeminiAgent` in the composition are the
generated boundary exports for the authored classes. The generated files call
`compileAgentClass(...)`; application code imports the boundaries and does not
lower authored classes by hand.

The render prop exposes only public getters and `@callable` methods from the
match agent. `result(handleTurn)` is an explicit grant: it binds the selected
player’s result to that callable in targets that implement result routing.
Nesting by itself grants no RPC access, and there is no method-name heuristic.
Serializable props remain child input; function props must be explicitly
branded at the composition site. Native Cloudflare `agentTool` is different:
the child's output returns to the parent model, and the Think target does not
invoke a `result(...)`-bound parent callable.

`Board` is ordinary reusable composition code. It selects the active seat and
injects only `side` plus a stable instance name; the compiler has no chess
special case. See [examples/chess](examples/chess/) for the complete game,
legacy generated Flue fixtures, and deployable Cloudflare Worker.

The deployable chess Worker executes the same boundary descriptor through the
generated Cloudflare Think class. The compiler supplies the actual turn as
transient props, runs Think's durable programmatic chat turn, and returns its
public text/reasoning stream. The move is validated before durable state changes;
the reasoning stream is capped and rendered as a thought bubble.

## What gets generated

| JSX concept | Cloudflare reconcile | Cloudflare model-driven | Legacy Flue adapter |
|---|---|---|---|
| authored Agent class | generated Durable Object class | `Think<Env>` subclass | low-level `agentComponent` profile |
| definition model | inert, with an emitted diagnostic | generated `getModel()` | not part of the full-definition contract |
| nested agent | child binding and migration | native `agentTool` or traced programmatic turn | parent `subagents` roster |
| serializable prop | `setProps` input | programmatic-turn props; schema-validated native tool input becomes child props | `session.task` input |
| passed callable ref | explicit generated RPC ACL | unsupported; native child output returns to the parent model | awaited task result or generated binding |
| definition prompt | available through `promptFor()` | `getSystemPrompt()` without skills; live `beforeTurn()` composition with the Session skill catalog when skills are present | legacy low-level instructions only |
| definition input/output schemas | boundary validation | native `agentTool` input-to-props and structured output validation | not part of the full-definition contract |
| definition tools | inert, with an emitted diagnostic | preserved AI SDK tools plus declarative tools | not newly lowered from class `render()` |
| definition skills and MCP | inert, with an emitted diagnostic | importable native skills and runtime MCP clients | not newly lowered from class `render()` |
| public reasoning | target-defined | generated text/reasoning trace | target-defined |

Cloudflare native `agentTool` preserves the child description, display name,
input schema, output schema, structured result, and stable tool-call run
identity. Schema-validated object input becomes the child definition's current
`this.props`, so its prompt and tools see the delegated values. The structured
child output is decoded by the child and validated/transformed exactly once by
the parent tool. It returns to the parent model; callback, method, `result(...)`,
and render-prop continuation grants are not carried into the native child facet,
and each dropped capability kind produces a target diagnostic. Parse-only
boundary validators are adapted to AI SDK v6; Standard Schema values such as
Zod pass through unchanged.

For the pre-existing low-level Flue adapter, Flue resolves subagents by
`AgentProfile.name`, so a prop-key tool slot such as `onCall` becomes a generated
alias profile with that exact name. Delegation uses Flue native
`session.task(text, { agent })`; the reactive workflow layer re-evaluates state
and folds explicit result bindings until the tree converges. This remains a
legacy adapter contract, not a claim that every field returned by class
`render()` is supported by Flue.

This follows the grain of both projects: Cloudflare provides child Durable
Objects, typed RPC, and `agentTool`; Flue provides named profiles, rosters,
tools, and retained child task sessions. agent-jsx supplies the typed
desired-state composition layer above them.

## Secrets and the chess Worker

The authored definitions keep explicit ids such as
`openrouter/openai/gpt-5-mini`. The Think emitter accepts a deployment-owned
`modelResolver` import, so provider packages and credentials stay out of agent
source and the compiler never guesses them from class names. This chess deploy
maps the explicit `openrouter/` prefix through the OpenRouter AI SDK provider;
other ids can fall through to Think's `AI` binding. The browser receives neither
provider credentials nor target bindings:

```sh
cd compat/chess
bun install
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put DEMO_ACCESS_TOKEN
bun run deploy
```

The Worker validates the Think result against the legal move list and chess.js,
then persists the move and its bounded public thought bubble in a Durable Object.
For a public product, replace the demo token with user authentication and rate
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

# Chess Think target and generated Worker checks
cd ../chess && bun run typecheck && bun run test
```

The root suite covers type failures, explicit capability routing, schema
validation, generated ACLs, reactive execution, chess alternation, and
byte-for-byte fixtures. The compatibility suites execute generated code against
the real target packages rather than mocks.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the package checks and Changesets-based
alpha release process.

## Further reading

- [COMPAT.md](COMPAT.md) — the compatibility-test contract.
- [COMPAT-REPORT.md](COMPAT-REPORT.md) — findings from the real target runtimes.
- [TODOS.md](TODOS.md) — outstanding release and project operations.
- [PDF-PIPELINE.md](PDF-PIPELINE.md) and [PARSEBENCH-RUN.md](PARSEBENCH-RUN.md) — the compiled PDF pipeline and its live evaluation.
- [Think target](docs/think-target.md) and [agent-tool investigation](docs/agent-tools-investigation.md) — model-driven Cloudflare compilation.
- [Cloudflare adapter](docs/cloudflare-adapter.md) — the original host-to-Durable-Object mapping.
- [Agent-first CLI](docs/agent-first-cli.md) — the CLI direction note.
- [Fixture guide](fixtures/README.md) — the compiler's byte-locked output families.

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
  `agentTool`, authored model + deployment resolver, transient turn-prop, and
  reasoning-trace emission.
- [docs-site/api/index.html](docs-site/api/index.html) — published SDK reference
  for the authored primitives.
- [src/compile/emit-flue.ts](src/compile/emit-flue.ts) — legacy Flue profiles,
  aliases, tools, and workflows.
- [COMPAT-REPORT.md](COMPAT-REPORT.md) — target limitations and compatibility
  findings.
