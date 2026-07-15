# Agent JSX chess Worker

This is the deployable half of `examples/chess`. The browser receives board
state only. `ChessGame` stores one game per id and executes one rendered Agent
JSX boundary per `/step` through a compiler-generated Cloudflare Think agent.

White uses an OpenAI model and black uses Gemini, both selected explicitly in
their authored classes as `openrouter/...` ids. The generated Think target calls
the deployment-owned `src/model-runtime.ts` adapter, which supplies the
OpenRouter AI SDK provider and Worker secret without moving provider policy into
the agent file. Think owns the durable chat turn and public reasoning stream.
`chess.js` validates every returned UCI move before durable state changes, and
bounded public reasoning—or the model's concise move note when no reasoning part
is emitted—becomes the move's thought bubble.

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

Production secrets belong in Cloudflare's encrypted secret store, not in
`wrangler.jsonc` or client code:

```sh
bunx wrangler secret put OPENROUTER_API_KEY --config wrangler.deploy.jsonc
bunx wrangler secret put DEMO_ACCESS_TOKEN --config wrangler.deploy.jsonc
bun run deploy
```

The model ids live in the hierarchy-free agent classes, not Worker vars or
filename inference. `emitThink({ modelResolver: ... })` wires those ids to the
deployment adapter; it does not inspect agent names. The deploy config uses
explicit self `script_name` values for production Durable Object bindings; the
dev config omits them so Wrangler can host the classes in one local process.
