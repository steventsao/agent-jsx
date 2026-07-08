# fixtures/ — what the compiler produces

Golden artifacts emitted from the human-authored component files. Two
families: the **uptime** set (single-level, dynamic fan-out) and the
**layout-review** set (three-level static nesting).

## uptime — [uptime-agent.tsx](../examples/uptime-agent.tsx) + [investigator.tsx](../examples/investigator.tsx)

| Fixture | Target | What it is |
|---|---|---|
| `uptime.cloudflare.ts` | cloudflare/agents | `UptimeDurable` + `InvestigatorDurable` over a generated `FiberAgentBase`: reconcile loop, `this.subagent(kind, name)`, `setProps`/callback RPC, real-fetch sensors, merge-safe `applyState`/`readState` |
| `uptime.wrangler.jsonc` | cloudflare | DO bindings + migrations for every generated class |
| `uptime.flue.ts` | flue | `defineAgent` module (resting prompt → instructions) + `spawnPlan(state)` |
| `investigator.flue.ts` | flue | child `defineAgentProfile` (props = task input, callback = task result) + target warnings for child-local state/infra that flue task profiles do not preserve |
| `uptime.workflow.ts` | flue | the reactive `defineWorkflow`: evaluate → delegate fresh children via `session.task` → fold results through `onResult` → repeat until at rest |

## layout-review — [layout-analyst.tsx](../examples/layout-review/layout-analyst.tsx) → [layout-reviewer.tsx](../examples/layout-review/layout-reviewer.tsx) → [bbox-extractor.tsx](../examples/pdf/bbox-extractor.tsx)

The three-level static hierarchy, discovered transitively from the root.

| Fixture | Target | What it is |
|---|---|---|
| `layout-analyst.cloudflare.ts` | cloudflare/agents | one Durable Object class per level; each `childBinding` reflects that level's own boundaries (root → layout-reviewer, mid → bbox-extractor, leaf → `{}`) |
| `layout-analyst.wrangler.jsonc` | cloudflare | DO bindings + migrations for all three classes |
| `layout-analyst.flue.ts` | flue | root `defineAgent` with native `subagents: [layoutReviewerProfile]`; `spawnPlan(state)` is the dynamic residue only (static `review:main` excluded) |
| `layout-reviewer.flue.ts` | flue | mid-level `defineAgentProfile` carrying its OWN `subagents: [bboxExtractorProfile]` (exactly flue's sketch) + a `spawnPlan(input)` for the prop-gated per-region fan-out |
| `bbox-extractor.flue.ts` | flue | leaf `defineAgentProfile` (task-delegation profile) |

`tests/fixtures.test.tsx` locks all of these byte-for-byte; regenerate
intentionally with `bun run fixtures` and review the diff — it is the emitters'
changelog. Runtime imports (`./runtime/...`) resolve to the react-free file set
listed in `src/compile/runtime-files.ts`.

The **uptime** set is proven against the REAL runtimes (workerd + @flue/runtime)
in `compat/` — see COMPAT-REPORT.md. The **layout-review** set is byte-locked
and unit-tested (`tests/nesting.test.tsx`, plus the runnable
[demo](../examples/layout-review/demo.tsx)) but is not yet exercised in a compat
package, so treat its real-runtime behavior as unproven.
