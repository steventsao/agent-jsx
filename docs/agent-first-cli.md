# agent-jsx as an agent-first CLI (direction note, 2026-07-07)

Reference points: **hyperframes** and **Postiz** — both successfully positioned
as agent-first CLIs: the primary user is an agent (Claude/codex) driving a
small, deterministic command surface with skills/docs written for models, and
the human reviews artifacts. agent-jsx should ship the same way — the
compiler is already artifact-first (fixtures ARE the changelog), which is
exactly the agent-legible property.

## The CLI surface (design target)

```
agent-jsx init <name>            scaffold an agent package (component files + tsconfig + skills stub)
agent-jsx sim <entry.tsx>        run the deterministic SimHost timeline (offline dev loop)
agent-jsx compile <entry.tsx>    emit cloudflare | flue targets + wrangler fragment (+ --fixtures to lock goldens)
agent-jsx test                   the layered gates: unit → workerd → flue (what /compat does today)
agent-jsx deploy <entry.tsx>     compile + wrangler deploy + post-deploy probe (state/prompt endpoints)
agent-jsx inspect <url>          read a deployed agent: /state /prompt /codemode
```

Everything the CLI does must be idempotent and diff-reviewable (regenerate →
git diff), because the calling agent's TDD loop depends on it. Errors must be
single-line actionable (models retry on them).

## Codemode: the deployed agent exposes its own lineage

Every deployed agent-jsx worker serves, next to its live state:

```
GET /state      current agent + children state (already shipped)
GET /prompt     the priompt-rendered context window (already shipped)
GET /codemode   { source: <the .tsx component files>, generated: <the emitted module>,
                  wrangler: <fragment>, fixtures: <goldens> }
```

The live URL carries the artifact's full lineage — source, compiled form,
oracle — so an agent (or a human) can inspect, fork, recompile, and redeploy
from nothing but the URL. This is the okra create-moat thesis ("artifacts +
codemode source + live shell at the same URL; lineage > bytes") applied to
agents, and it composes with Cloudflare's Code Mode direction (agents writing
code against capability surfaces rather than picking tools): the component
file IS the capability declaration, and /codemode is how another agent reads
it.

First shipping increment: the Phase B pdf worker (`agent-jsx-pdf-compiled`)
serves /codemode with the two component sources + the generated module.
CLI proper is a post-pipeline milestone; this doc is its contract sketch.

## Third reference: PostHog MCP/CLI — the query-first surface

What PostHog's MCP gets right (and hyperframes/Postiz don't need): a huge
domain exposed through ONE composable query primitive (HogQL via
`execute-sql`) rather than hundreds of bespoke tools, with docs-search living
inside the MCP so the agent self-serves the schema. For agent-jsx that maps
to:

- `agent-jsx query "<expr>"` / an MCP `query` tool — one primitive over the
  FLEET's state: which agents exist (DO registry), their `/state`, children,
  prompt renders, task/schedule rosters. Think "SQL over the reconciled
  desired-state + live state", not per-question endpoints.
- The generated classes already expose the uniform read surface this needs
  (`readState`, `promptFor`, `/codemode`); the query layer composes them.
- Ship schema+docs INSIDE the surface (a `docs` tool / `--help` that a model
  can grep), PostHog-style, so the CLI is self-describing to its primary user.

1.1 scope, same milestone as the CLI.
