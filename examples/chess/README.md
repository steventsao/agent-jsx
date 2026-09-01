# Two-agent chess

Each authored agent is a hierarchy-free, Cloudflare-style class. The match owns
state and offers one public operation:

```tsx
export default class ChessMatchAgent extends Agent<ChessState> {
  static agentName = "chess-match";
  initialState = initialChessState;

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
  handleTurn(decision: ChessDecision | string) {
    this.setState((state) => reduceChessTurn(state, decision));
  }
}
```

Player classes return their complete model-facing definition from the required
`render()` method:

```tsx
render() {
  return this.define({
    model: "openrouter/openai/gpt-5-mini",
    prompt: <PlayerPrompt provider="OpenAI" turn={this.props.turn} />,
  });
}
```

`this.define(...)` can also declare input/output schemas, tools, Cloudflare
`SkillSource` values, and named MCP servers with an HTTP URL plus optional
transport. It is declarative agent configuration, never UI, and contains no
parent/subagent assumptions. Individual AI SDK tool objects keep their metadata
while the map is re-derived from the current definition. Hierarchy remains an
explicit composition concern. The model-driven Cloudflare target is the
complete lowering for this definition surface.

Hierarchy and authority live in `match.tsx`:

```tsx
export const ChessMatch = composeAgent(
  <ChessMatchAgent name="match">
    {({ turn, handleTurn }) => turn && (
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
    )}
  </ChessMatchAgent>,
);
```

`Board` treats child order as seats, renders one boundary per ply, and injects
only the selected `side` and stable name. The render prop exposes the match
getter and `@callable` method; `result(handleTurn)` explicitly grants that
result sink to each player for targets and hosts that implement result routing.
Nesting alone grants nothing. Native Cloudflare `agentTool` instead returns the
child output to the parent model and does not invoke a result-bound parent
callable. When a child definition declares schemas, validated object input is
bound as that child's current `this.props`, and its structured output is
validated before returning to the parent model. The deployable chess host
validates and folds each decision through its reactive execution step.

The compiler generates class-to-boundary companions, infers representative
player props from this composition, and emits the model-driven Cloudflare
target. The generator also refreshes the repository's pre-existing legacy Flue
fixtures; they remain low-level compatibility fixtures, and no model, prompt,
tool, skill, or MCP field from `render()` is newly lowered to Flue. Think's
generated `runTurnWithTrace(input, props)` bridge runs a durable chat turn and
returns its public text/reasoning stream; the chess Worker stores bounded
public reasoning—or the move note fallback—as each move's thought bubble.

```sh
bun run chess:generate
```

Installed-package generators import `emitThink`, `emitCloudflare`, graph
discovery, and analysis from
`@agent-jsx/core/compile/cloudflare`; this in-repository generator uses
the source modules directly so its checked-in fixtures exercise the same code.

The deployable UI + Durable Object Worker is in `compat/chess`. Models are the
explicit strings in the player definitions. Its `modelResolver` target option
maps the explicit `openrouter/` ids to an authenticated AI SDK provider; the
compiler does not infer a provider from an agent/class name. The browser sends
only a demo access token and never receives model credentials or Durable Object
bindings.
