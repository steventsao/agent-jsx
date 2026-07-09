# Investigation: `agents@0.17` `agentTool` + `@cloudflare/think` vs our `agents@0.8.7` runtime

**Question.** agent-jsx generates Durable Object classes extending a hand-rolled
`FiberAgentBase extends Agent<Env,State>` on `agents@0.8.7`, addressed by
`getAgentByName` and driven by a deterministic reconcile (evaluate → diff →
apply → spawn). Steven's target compiles a slot binding to
`getTools() { return { onCall: agentTool(MySubagentDurable, { description, inputSchema }) } }`.
`agentTool` lives in `agents@0.17.3` (`agents/agent-tools`) + `@cloudflare/think@0.12.1`,
neither installed here. **Do we upgrade the runtime, or emit `getTools` behind a
version gate?**

Citations are `package@version relative/dist/path:line`, verified against the
published npm dists (npm-packed and read) and the partyserver base; the local
`~/dev/cloudflare-agents-playground` checkout (HEAD `fc6d214`, PR #1201) was used
for *shapes* only (its internal versions read 0.1.0/0.8.5, they do not track npm).

## 1. What `agentTool` does

Signature (`agents@0.17.3 dist/agent-tools.d.ts:38-41`):

```ts
declare function agentTool<Input = unknown, Output = unknown>(
  cls: ChatCapableAgentClass,
  options: AgentToolFactoryOptions<Output>
): Tool<Input, string | Output | AgentToolFailure>;
```

`AgentToolFactoryOptions = { description: string; inputSchema: unknown; outputSchema?: SchemaLike<Output>; displayName?: string; icon?; display? }`
(`dist/agent-tools.d.ts:25-33`). It returns an **AI-SDK `Tool`** (from `"ai"`) whose
`execute` dispatches a sub-agent (`dist/agent-tools.js`):

- **(a) spawn cadence — per model tool-call.** `execute` derives
  `runId = agent-tool:${toolCallId}` and calls `runAgentTool(cls, { input, runId, … })`,
  which does `const child = await this.subAgent(cls, runId)` (`dist/index.js:4401`) — a
  child DO named per tool-call. Runs are idempotent by `runId` (`dist/index.js:4281-4296`).
- **(b) lifetime — a facet.** The child is a facet DO with *"its own isolated SQLite
  storage running on the same machine"* (`dist/agent-tool-types-CNyE1iz_.d.ts:3800-3812`).
  Awaited by default (the turn blocks to a terminal status, returns `result.summary`);
  `{ detached }` runs outlive the turn under budgets + an `onFinish` method callback
  (`dist/agent-tool-types-CNyE1iz_.d.ts:5007-5099`). Terminal runs are retained for
  replay until `clearAgentToolRuns()` (`dist/index.js:4835-4837`).
- **(c) `inputSchema` is enforced at the MODEL boundary, before spawn.** It is passed
  straight into `tool({ inputSchema })`; the AI SDK validates the model's tool-call args
  before `execute` runs. `outputSchema` is enforced *inside* `execute` after completion
  (`return options.outputSchema.parse(result.output)`).
- **(d) `cls` must be a `Think`/`AIChatAgent` subclass.** Type: `ChatCapableAgentClass = { new (ctx, env): T extends Agent }`
  (`dist/agent-tool-types-CNyE1iz_.d.ts:5122,2001-2003`). At dispatch the runtime throws
  *"Agent tool child must implement the framework agent-tool adapter. Use a @cloudflare/think
  Think subclass or an AIChatAgent subclass."* (`dist/index.js:5256`). Resolved via
  **`ctx.exports` (facets), not a wrangler binding** — `cls.name` must equal the worker
  export name, no renamed re-exports (`dist/agent-tool-types-CNyE1iz_.d.ts:1993-2001`).
- **(e) registration is `getTools(): ToolSet`.** But `getTools` is a method of the chat
  hosts, **not base `Agent`** (`rg -c getTools dist/agent-tool-types-CNyE1iz_.d.ts` → 0).
  `Think.getTools()` builds the agentic loop each turn (`@cloudflare/think@0.12.1
  dist/index-WF0HQmkk.d.ts:1822`, `dist/think.js:2422`).

## 2. What `Think` is

A **base class extending `Agent`** — the chat host (`@cloudflare/think@0.12.1
dist/index-WF0HQmkk.d.ts:1214-1218`). It adds the **LLM agentic chat-turn engine**:
`getModel()`, `getSystemPrompt()`, `getTools(): ToolSet`, the tool-calling loop,
message persistence/streaming, durable turns, MCP/skills. Base `Agent` carries the
primitives (`runAgentTool`, `subAgent`/facets, `schedule`, state) but **no turn loop
and no `getTools`**. `@cloudflare/think@0.12.1` peer-requires
`agents ">=0.17.1 <1.0.0"`, `ai ^6`, `zod ^4`, `react ^19` (`package.json` peerDependencies).

**Required, both ends, not orthogonal.** The parent needs `getTools()` + an active turn
(`agentTool`'s `currentAgentToolRunner()` errors *"Use it from getTools() on an Agent
subclass"*, `dist/agent-tools.js`); the child must be a `Think`/`AIChatAgent` (the throw
at `dist/index.js:5256`).

**Relation to `FiberAgentBase`.** `Think` would REPLACE the deterministic reconcile loop
with a model-driven chat turn (children produce text summaries, the model decides
tool-calls) — a different execution model, not a drop-in for the reconciler.

## 3. `0.8.7 → 0.17.3` breaking surface (vs COMPAT-REPORT #1–#36)

| Concern | 0.8.7 | 0.17.3 | Verdict | Citation |
|---|---|---|---|---|
| `getAgentByName` | root export, `(ns, name, opts?) → Promise<Stub>` | identical | HOLDS | 0.8.7 `dist/index.d.ts:79`; 0.17.3 `dist/index.d.ts:179`, `dist/agent-tool-types-CNyE1iz_.d.ts:4791-4799` |
| `onStateChanged` (#2) | `(state, source)`; `onStateUpdate` deprecated | identical; still `@deprecated onStateUpdate` | HOLDS | 0.17.3 `dist/agent-tool-types-CNyE1iz_.d.ts:2788-2798` |
| `setState` full-replace + `_cf_` keys (#3) | full-replace; hides `_cf_` | unchanged; `CF_INTERNAL_KEYS`, `_cf_` preserved across setState | HOLDS (merging `boundStore` still needed) | 0.17.3 `dist/index.js:1075-1082,193-219` |
| `schedule`/`getSchedules`/`cancelSchedule` (#5) | `schedule(when,cb,payload,{idempotent})`; `getSchedules()` sync | `schedule()` identical; **`getSchedules()` `@deprecated`** (throws inside facets) → new async `listSchedules()`; `scheduleEvery()` | MOSTLY HOLDS — one soft break (a top-level DO still returns, warns) | 0.17.3 `dist/agent-tool-types-CNyE1iz_.d.ts:3114-3197` |
| `onStart` + `blockConcurrencyWhile` (#34) | gate-closed onStart | unchanged (partyserver `^0.5.8`) | HOLDS | `partyserver@0.5.8 dist/index.js:710-713` |
| `Agent → Server → DurableObject` (#21) | `Agent extends Server(partyserver)` | unchanged | HOLDS (DO-RPC structured-clone) | 0.17.3 `dist/index.js:17,397` |
| partyserver `this.name` throw (#1/#33) | getter throws unless routed | unchanged, stricter message; agents still reads `this.name` on state ops | HOLDS (route via `getAgentByName`) | `partyserver@0.5.8 dist/index.js:776-780`; agents reads at `dist/index.js:479,772,1361,1423` |
| facets (g) | embryonic (6 mentions, behind `experimental`) | backbone (113 mentions); `subAgent`/`agentTool` run children as `ctx.exports` facets | NEW / additive — does not change our `getAgentByName` DO-per-entity model | 0.8.7 `dist/index-C-6EMK-E.d.ts:2175-2182`; 0.17.3 `dist/agent-tool-types-CNyE1iz_.d.ts:3800-3812` |

**Net:** every load-bearing semantic agent-jsx relies on is unchanged or additively
extended. The only touch-point is `getSchedules()` deprecation — a one-line, opt-in
`listSchedules()` migration, forward-safe for our top-level DOs.

## Verdict — (B) implement slot semantics now, gate the `getTools` emit, do NOT upgrade the runtime

Two distinct questions:

1. **Upgrading the runtime 0.8.7 → 0.17.3 is LIGHT** — nothing we depend on broke.
2. **Adopting `agentTool` is HEAVY** — it forces generated parents onto `Think` (an LLM
   chat engine) and generated children onto `Think`/`AIChatAgent`, spawned per-tool-call
   as `ctx.exports` facets producing text summaries. That is architecturally *in tension*
   with our deterministic reconcile→diff→spawn model (children addressed by `getAgentByName`,
   driven by `setProps`/callbacks).

`agentTool` is a **separate, additive emit target** — new subpath, new base class — not a
modification of `FiberAgentBase`. So implement the slot→`getTools` discovery/eval semantics
now (host-agnostic: the slot-handle marker, binding detection, discovery, flue subagents),
and emit the `getTools` block behind a **version-gated emitter option** targeting the 0.17
`agents/agent-tools` + `Think` API — proven by emitted-string tests + this doc — WITHOUT
touching the green 0.8.x reconcile runtime. Consumers who install the 0.17 + `@cloudflare/think`
stack opt into `agentTool` delegation; everyone else keeps the proven reconciler.

**3 strongest citations:**

1. **`agentTool` drags in the whole 0.17 stack, not a runtime-wide migration.** The
   `./agent-tools` subpath **exists in 0.17.3, absent in 0.8.7** (0.17.3 `package.json`
   exports `"./agent-tools"`; 0.8.7 has no such key), and `@cloudflare/think@0.12.1`
   peer-requires `agents ">=0.17.1 <1.0.0"` (`package.json` peerDependencies). → gate it.
2. **Our runtime semantics are unchanged in 0.17.3**, so there is no runtime-migration
   pressure: partyserver `name` still throws (`partyserver@0.5.8 dist/index.js:776-780`),
   `onStart` still gated by `blockConcurrencyWhile` (`:710-713`), `Agent extends Server`
   (`agents@0.17.3 dist/index.js:17,397`), `onStateChanged` identical
   (`dist/agent-tool-types-CNyE1iz_.d.ts:2788-2791`), `schedule()` identical (`:3114-3122`).
3. **`agentTool` structurally requires `Think` on both ends** (in tension with the
   reconciler): base `Agent` has 0 `getTools` (only `Think` — `@cloudflare/think dist/index-WF0HQmkk.d.ts:1822`),
   the child must be *"a @cloudflare/think Think subclass or an AIChatAgent subclass"*
   (`agents@0.17.3 dist/index.js:5256`), children spawn per-tool-call as facets
   (`this.subAgent(cls, runId)`, `dist/index.js:4401`). → keep it a separate, opt-in target.

## How to emit a `getTools` block for 0.17 (the gated emitter's target)

Import: `import { agentTool } from "agents/agent-tools";` (exports map
`"./agent-tools": { import: "./dist/agent-tools.js" }`). `ToolSet` from `"ai"`.

The parent extends `Think` and overrides `getTools(): ToolSet` (a method), returning a
record of `agentTool(...)` entries; it also needs `getModel()`. The child class ref (NOT a
binding string) must be a `Think`/`AIChatAgent` subclass exported under its exact class
name:

```ts
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import type { ToolSet, LanguageModel } from "ai";

export class MainAgentDurable extends Think<Env> {
  getModel(): LanguageModel { /* an AI-SDK model */ }
  getTools(): ToolSet {
    return {
      onCall: agentTool(MySubagentDurable, {
        description: MySubagent.spec.description,
        inputSchema: MySubagent.spec.inputSchema, // AI SDK validates at the model boundary
      }),
    };
  }
}
export class MySubagentDurable extends Think<Env> { getModel(): LanguageModel { /* … */ } }
```

Shape confirmed against playground `packages/think/src/e2e-tests/worker.ts:17-40`,
`assistant-agent-loop.ts:200-208`. Wrangler: the parent needs its DO binding + migration;
the child facet is spawned via `ctx.exports` (no separate binding), but must be an exported
class. `agents/agent-tools` + `@cloudflare/think` installed, `agents >=0.17.1`.

**One uncertainty:** no checked-in source file combines `getTools()` returning `agentTool(...)`
verbatim; the composition is asserted by `agentTool`'s own error string ("Use it from
getTools() on an Agent subclass"), the Think guidance (`dist/think.js:3339`), and the CF
docs example — the individual pieces (getTools→ToolSet; agentTool→Tool) are each source-verified.

Docs: <https://developers.cloudflare.com/agents/runtime/execution/agent-tools/>,
<https://developers.cloudflare.com/agents/api-reference/think/>.
