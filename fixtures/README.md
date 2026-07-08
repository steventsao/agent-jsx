# fixtures/ — what the compiler produces

Golden artifacts emitted from exactly two human-authored component files
([examples/uptime-agent.tsx](../examples/uptime-agent.tsx) and
[examples/investigator.tsx](../examples/investigator.tsx)):

| Fixture | Target | What it is |
|---|---|---|
| `uptime.cloudflare.ts` | cloudflare/agents | `UptimeDurable` + `InvestigatorDurable` over a generated `FiberAgentBase`: reconcile loop, `this.subagent(kind, name)`, `setProps`/callback RPC, real-fetch sensors, merge-safe `applyState`/`readState` |
| `uptime.wrangler.jsonc` | cloudflare | DO bindings + migrations for every generated class |
| `uptime.flue.ts` | flue | `defineAgent` module (resting prompt → instructions) + `spawnPlan(state)` |
| `investigator.flue.ts` | flue | child `defineAgentProfile` (props = task input, callback = task result) + target warnings for child-local state/infra that flue task profiles do not preserve |
| `uptime.workflow.ts` | flue | the reactive `defineWorkflow`: evaluate → delegate fresh children via `session.task` → fold results through `onResult` → repeat until at rest |

`tests/fixtures.test.tsx` locks these byte-for-byte; regenerate intentionally
with `bun run fixtures` and review the diff — it is the emitters' changelog.
All five are proven against the REAL runtimes (workerd + @flue/runtime) in
`compat/` — see COMPAT-REPORT.md. Runtime imports (`./runtime/...`) resolve to
the react-free file set listed in `src/compile/runtime-files.ts`.
