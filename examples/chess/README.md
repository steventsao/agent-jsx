# Two-agent chess

The authored match is deliberately this small:

```tsx
const handleTurn: ChessPlayerProps["onTurn"] = (decision) =>
  applyChessTurn(store, decision);

return (
  <Board turn={turn}>
    <Agent agentClass={OpenAIAgent} turn={turn} onTurn={handleTurn} />
    <Agent agentClass={GeminiAgent} turn={turn} onTurn={handleTurn} />
  </Board>
);
```

`Board` treats child order as seats, renders one boundary per ply, and injects
only the selected `side` and stable name. Every `Agent` explicitly receives its
`turn` data and `onTurn={handleTurn}` capability. Each player is authored as a
normal default JSX function plus an explicit `profile` (`name`, `model`, state,
and capability ACL). The compiler-generated companion supplies the internal
`agentComponent`, so composition sees normal subagent records:

- serializable `turn` data flows down as task/RPC input;
- `onTurn` is a callback capability and folds the result into board state;
- stable ids are generated as `white:0`, `black:1`, and so on;
- `chess.js` is the authority for legal moves, checkmate, and draws.

Generate the boundary companions, readable Flue binding table, player
profiles, and reactive workflow:

```sh
bun run chess:generate
```

The deployable UI + Durable Object Worker is in `compat/chess`. Provider keys
exist only as Worker secrets. The browser sends a separate demo access token
and never receives OpenRouter or Gemini credentials.
