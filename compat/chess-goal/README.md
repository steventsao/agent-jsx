# Agent JSX chess-goal Worker

The deployable half of `examples/chess-goal`: the chess match rewritten on the
goal/phase supervision layer. A goal machine — `white ⇄ black` on `moved`, both
`ended → over` — decides which model seat is mounted; the seats are the
UNCHANGED agents from `examples/chess` (OpenAI plays white, Gemini black, both
as explicit `openrouter/...` ids resolved by `src/model-runtime.ts`).

`ChessGoalGame` stores one game per id. Each `/step` executes one rendered
boundary through a compiler-generated Cloudflare Think agent and folds the
decision through the TWO-REDUCER SPLIT: `reduceChessTurn` (chess.js) decides
whether an outcome happened; the goal reducer decides what it means. Durable
state carries the board, the goal snapshot, and the ATTRIBUTED transition log
(`white[seat:white] moved ▶ black`) side by side.

Deliberate difference from `compat/chess`: an illegal model move is NOT a
transport error. `src/providers.ts` passes the decision through; the domain
refuses it (`lastError`), no outcome is dispatched, the same phase stays
mounted, and the next `/step` re-prompts the same seat (same Think session)
with the refusal in its turn message. A late/out-of-turn callback is refused by
the goal reducer as `stale`. The default ply cap is LOW (16, ceiling 40) so a
runaway match dies cheap.

```sh
bun install
bun run test
bun run typecheck

# Local development only; never commit this file:
cat > .dev.vars <<'VARS'
OPENROUTER_API_KEY=...
DEMO_ACCESS_TOKEN=...
VARS
bun run dev
```

Production secrets belong in Cloudflare's encrypted secret store:

```sh
bunx wrangler secret put OPENROUTER_API_KEY --config wrangler.deploy.jsonc
bunx wrangler secret put DEMO_ACCESS_TOKEN --config wrangler.deploy.jsonc
bun run deploy
```

Routes (all game routes require `authorization: Bearer <DEMO_ACCESS_TOKEN>`):

- `GET  /health`
- `POST /api/games/:id/reset` — body `{"maxPlies": 16}` (clamped 2..40)
- `POST /api/games/:id/step` — one model move; returns state + descriptor
- `GET  /api/games/:id/state`

The deploy config uses explicit self `script_name` values for production
Durable Object bindings; the dev config omits them so Wrangler can host the
classes in one local process.
