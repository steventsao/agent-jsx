# Two-agent chess

Each authored agent is a hierarchy-free, Cloudflare-style class. The match owns
state and offers one public operation:

```tsx
export default class ChessMatchAgent extends Agent<ChessState> {
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

Player classes explicitly select their model and return prompt JSX from
`getPrompt()`. They contain no parent/subagent assumptions. An optional
`render()` would be UI only and would never enter the agent context.

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
result sink to each player. Nesting alone grants nothing.

The compiler generates class-to-boundary companions, infers representative
player props from this composition, and emits the Flue binding table, player
profiles, and reactive workflow:

```sh
bun run chess:generate
```

The deployable UI + Durable Object Worker is in `compat/chess`. Provider keys
exist only as Worker secrets. The browser sends a separate demo access token
and never receives OpenRouter or Gemini credentials.
