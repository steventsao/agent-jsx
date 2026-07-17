# Think target: model-driven delegation as a first-class compile mode

One component source, two Cloudflare execution paradigms plus flue. **reconcile
mode** (shipped) is deterministic: `FiberAgentBase` renders → diffs → applies,
subagent boundaries spawn child DOs, the runtime drives the work. **think mode**
(new) is model-driven: the parent extends `@cloudflare/think`'s `Think<Env>`, the
component's context window is the system prompt, every child boundary is an
`agentTool`, and the MODEL decides what to call.

## Mode matrix

| Component concept | CF reconcile (`emitCloudflare`) | CF think (`emitThink`) | flue (`emitFlue`) |
|---|---|---|---|
| `agentComponent(spec)` | `class X extends FiberAgentBase` | `class X extends Think<Env>` | `defineAgent(() => config)` (no base class) |
| `<prompt>` / `spec.getPrompt` | `promptFor(budget)` (per-turn seam) | `getSystemPrompt()` (re-rendered each turn) | `instructions` (rendered at rest) |
| child `<subagent>` boundary | `this.subagent(kind,name)` + `setProps`/callback RPC | `getTools()` → `agentTool(ChildDurable, {description, inputSchema})` | `subagents: [Profile]` + `session.task(t,{agent})` |
| tool-slot binding (`onCall={handle}`) | version-gated `getTools()` bolt-on (preview) | `getTools()` → `agentTool` named by the **prop key** | `subagents:` (same child, named roster) |
| `<tool name description run>` | reconciled infra row (`tool:`) | `getTools()` → `tool({description, execute: run})` | **`tools: [defineTool(...)]`** (Phase 3) |
| `<sensor>` / `<schedule>` | converged durable rows (`this.schedule`) | **UNSUPPORTED** — loud diagnostic | not emitted (belongs in a flue cron workflow) |
| `<task>` (one-shot) | run-once-per-name, guarded in state | **UNSUPPORTED** — the model does the work via tools | not emitted (delegated task result) |
| the execution loop | the reconcile drain (evaluate→diff→apply) | Think's `onChatMessage` agentic turn | the harness + `session.prompt`/`session.task` |
| model | n/a (deterministic) | generated `getModel()` from the explicit class model | `model: "<provider>/<model>"` |
| public reasoning stream | n/a | generated `runTurnWithTrace()` returns text + reasoning | target-defined |
| reasoning effort | n/a | per-model | `thinkingLevel: off…xhigh` |

### Authored model ids, deployment-owned providers

`getModel()` is generated from the class's explicit `model` value; the emitter
never infers a provider from a class, export, filename, or agent name. When a
provider needs an SDK package or secret, pass a target adapter:

```ts
emitThink(root, children, analysis, {
  modelResolver: {
    importPath: "../model-runtime.ts",
    exportName: "resolveDeploymentModel",
  },
});
```

The generated method becomes
`resolveDeploymentModel(this.env, Agent.spec.model)`. For example, the chess
deployment maps its explicit `openrouter/` ids to
`@openrouter/ai-sdk-provider` with `OPENROUTER_API_KEY`; ids that need no custom
credentials can remain plain strings for Think's built-in `AI` binding. This is
runtime adaptation, not model or hierarchy inference.

**What is unsupported, per mode, and why.** think mode has no reconcile loop, so
`<sensor>`/`<schedule>`/`<task>` (durable-infra convergence, reconcile's job) do
not map onto `getTools`/`getSystemPrompt` — the emitter emits a loud
`// TARGET WARNING [think-*-unsupported]` header (the same target-diagnostics
mechanism flue uses) and drops them. reconcile mode has no model, so model-driven
delegation is absent by design (a slot binding degrades to the version-gated
`getTools` preview, never executed on the 0.8.x runtime).

## Flue verdict — flue "has think", but as config, not a base class

**Question (Steven):** "I bet they have think too." **Answer: structurally yes,
by-class no.** flue has no `Think` base class; its harness + `session` IS the
model-driven agentic loop, and `defineAgent` config (`instructions`/`tools`/
`subagents`/`thinkingLevel`) is the exact `getSystemPrompt`/`getTools` surface.

Citations (READ-ONLY `~/dev/flue`, `@1.0.0-beta.8` + the public docs):

1. **No base class — config/function only.** "Flue does **not** use class
   inheritance for agents… an agent is a file in `src/agents/` whose default
   export is created with `defineAgent(...)`" — <https://flueframework.com/docs/guide/building-agents/>.
   `defineAgent(initialize)` returns a frozen `{__flueAgentDefinition, initialize}`,
   not a class (`packages/runtime/src/agent-definition.ts:76-87`); there is no
   `Think`/base export in `packages/runtime/src/index.ts`.
2. **`thinkingLevel` IS flue's "think" — reasoning effort as config.** Valid
   levels `off|minimal|low|medium|high|xhigh` (`agent-definition.ts:16-23`,
   asserted `:205-211`), settable on a profile, an agent, or per delegated task
   (`examples/hello-world/src/workflows/with-thinking.ts:10-15,23-31`).
3. **The harness/session is the loop (Think's `onChatMessage`).** A model turn is
   `session.prompt(text, { tools })` (`examples/hello-world/src/workflows/with-tools.ts:35-38`);
   delegation is `session.task(text, { agent })` (`with-thinking.ts:23-31`) — the
   built-in task capability the docs describe as delegating "source lookup to
   `policy_researcher`".
4. **`getTools` ↔ `tools:` + `subagents:`.** `defineAgentProfile`/`defineAgent`
   config carry `tools`, `subagents`, `thinkingLevel` (AgentProfileSchema
   `agent-definition.ts:25-43`). `defineTool({name, description, input?, output?, run})`
   (`packages/runtime/src/tool.ts:16-34`) is the tool primitive; its `input` MUST
   be a **valibot** top-level object schema (`tool.ts:48-55`, `schema.ts:22-45`
   `isValibotSchema` requires `vendor === 'valibot'`).

**Consequence for our flue emit.** It is ALREADY the think-shape: `instructions`
= the rendered system prompt, `subagents:` = the delegation roster (the child
boundaries → agentTools correspondence), `model` = `getModel`. The mapping table:

| Think (CF) | flue | agent-jsx source |
|---|---|---|
| `class extends Think<Env>` | `defineAgent(() => cfg)` | `agentComponent(spec)` |
| `getModel()` | `model:"<provider>/<model>"` | emit arg |
| `getSystemPrompt()` | `instructions` | `<prompt>` / `spec.getPrompt` |
| `getTools()`→`agentTool(Child,…)` | `subagents:[Profile]` + `session.task` | child `<subagent>` boundary |
| `getTools()`→`tool(…)` | `tools:[defineTool(…)]` | `<tool>` record — **Phase 3 gap** |
| `onChatMessage` turn loop | harness + `session.prompt`/`.task` | (runtime, not emitted) |
| per-model reasoning | `thinkingLevel` | (unmodeled) |
| `inputSchema` (zod, model boundary) | `defineTool.input` (valibot) | `spec.inputSchema` (zod) |

**The one gap (Phase 3): `<tool>` records were skipped on flue.** Now emitted as
`tools: [defineTool({name, description, run})]`. **zod→valibot decision:
description-only pass-through, no converter.** The `<tool>` intrinsic
(`src/types.ts` `ToolProps`) carries `{name, description, run}` and NO input
schema, so there is nothing to convert; `defineTool.input` is optional, so a
schemaless `defineTool` is valid. A subagent's `spec.inputSchema` (zod) does NOT
travel to a flue subagent — `defineAgentProfile` has no `inputSchema` field
(`agent-definition.ts:25-43`), so flue delegation is description-only there too
(it is enforced at the CF `agentTool` model boundary, not on the flue side). If a
future `<tool>` carries a valibot input schema it passes straight through (flue
wants valibot natively; agent-jsx authors would use valibot, not zod, for a
flue-targeted tool).

## Concrete — one component, three ways

Source (`examples/tool-slot/`, the acceptance composition):

```tsx
<Coordinator name="coord">{(handleCall) => <Worker name="w" onCall={handleCall} />}</Coordinator>
```

`Coordinator` (`toolSlot: true`) names no child; the composition binds `Worker`
to the `onCall` prop. `Worker.spec` carries `description` + zod `inputSchema`.

**CF reconcile** (`emitCloudflare`, existing): `CoordinatorDurable extends
FiberAgentBase` renders the prompt; at runtime the slot mounts no standing child
(a tool, not a subagent). With `{agentTools:true}` a version-gated `getTools()`
bolt-on previews the delegation but is NOT executed on the 0.8.x reconcile
runtime (see `docs/agent-tools-investigation.md`).

**CF think** (`emitThink`, new): the delegation is real — the model calls the
tool, `agentTool` spawns the `ToolWorkerDurable` facet.

```ts
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import type { LanguageModel, ToolSet } from "ai";

export class CoordinatorDurable extends ThinkAgentBase<CoordinatorState> {
  getModel() { return Coordinator.spec.model; } // when explicitly authored
  getSystemPrompt(): string { /* Coordinator's <prompt> rendered over this.state */ }
  getTools(): ToolSet {
    return {
      // slot binding → tool NAMED BY THE PROP KEY, schema'd by the child's spec
      onCall: agentTool(ToolWorkerDurable, {
        description: Worker.spec.description,
        inputSchema: Worker.spec.inputSchema,
      }),
    };
  }
}
export class ToolWorkerDurable extends ThinkAgentBase<WorkerRuntimeState> {
  getSystemPrompt(): string { /* Worker's <prompt>: "Answer one research query" */ }
  // leaf: no child boundaries → getTools() = {} ; its <task> is think-unsupported
}
```

A PLAIN nested child (not slot-bound) becomes an `agentTool` named by its **kind**
(sanitized), e.g. `investigator: agentTool(InvestigatorDurable, {…})`.

**flue** (`emitFlue`, existing + Phase 3): the same child is a native `subagents:`
roster entry; a `<tool>` (if present) is a `tools: [defineTool(...)]`.

```ts
import { defineAgent } from "@flue/runtime";
export default defineAgent(() => ({
  model: "openrouter/google/gemini-3.1-flash-lite-preview",
  instructions: "…Coordinate the task; call the bound worker tool…",
  subagents: [tool_workerProfile], // session.task(…, { agent: "tool-worker" })
}));
```

## What the compat proof establishes (`compat/think`, real workerd)

Pinned to `agents@0.17.4` + `@cloudflare/think@0.13.0`. The seam for testing
WITHOUT a live LLM is a **mock `LanguageModelV3`**
(a `doStream` returning AI-SDK stream parts), the pattern the playground's
`LoopToolTestAgent` uses (`packages/think/src/tests/agents/assistant-agent-loop.ts`).
Provable in real workerd via `runInDurableObject` (no `@callable` needed):

1. **boot** — `CoordinatorDurable`/`ToolWorkerDurable extends Think` instantiate as
   DOs (`getAgentByName`); a bare Think with no `getModel` boots and only errors on
   a chat turn (playground `BareAssistantAgent`).
2. **getSystemPrompt()** — returns the component's rendered context window (pure,
   no model).
3. **getTools() registration** — `agentTool(ToolWorkerDurable, {…})` builds without
   an active turn; the tool set has the expected keys (`onCall`) with an `execute`.

The tool-call → child-facet SPAWN (`agentTool.execute` → `this.subAgent(cls, runId)`)
needs an active turn — driven modelless by a mock model; documented as the frontier
and left to emitted-string assertions where the workerd install is too heavy.
