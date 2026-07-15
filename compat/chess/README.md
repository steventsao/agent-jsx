# Agent JSX chess Worker

This is the deployable half of `examples/chess`. The browser receives board
state only. Provider calls run inside `ChessGame`, a Durable Object that stores
one game per id and executes one rendered Agent JSX boundary per `/step`.

White uses an OpenAI model through the available OpenRouter account; black uses
Gemini directly. `chess.js` validates every returned UCI move before durable
state changes.

```sh
bun install
bun run test
bun run typecheck

# Local development only; never commit this file:
cat > .dev.vars <<'VARS'
OPENROUTER_API_KEY=...
GEMINI_API_KEY=...
DEMO_ACCESS_TOKEN=...
VARS
bun run dev
```

Production secrets belong in Cloudflare's encrypted secret store, not in
`wrangler.jsonc` or client code:

```sh
bunx wrangler secret put OPENROUTER_API_KEY --config wrangler.deploy.jsonc
bunx wrangler secret put GEMINI_API_KEY --config wrangler.deploy.jsonc
bunx wrangler secret put DEMO_ACCESS_TOKEN --config wrangler.deploy.jsonc
bun run deploy
```

The non-secret model ids are ordinary Worker vars in `wrangler.jsonc`.
The deploy config uses an explicit self `script_name` for the production
Durable Object binding; the dev config omits it so Wrangler can host the class
in the same local process.
