# Upstream alignment: Cloudflare Agents and Flue

Research snapshot: 2026-07-17.

This note separates three things that are easy to blur together:

1. APIs proven by this repository's exact-version compatibility suites.
2. Accepted or documented upstream direction that should shape our authoring
   contract.
3. Open roadmap items and discussions that must not become compatibility
   claims yet.

## Executable baseline

| Target | Version | What is proven here |
|---|---|---|
| Cloudflare reconcile | `agents@0.17.4` | generated Durable Object classes, state/prop pushes, schedules, child RPC, callback ACLs, continuation fan-out, and shutdown run in real workerd |
| Cloudflare Think | `agents@0.17.4` + `@cloudflare/think@0.13.0` | generated Think classes boot, build prompts/tools, and register native `agentTool` children in real workerd; the chess target also typechecks and runs its deterministic turn tests |
| Flue | `@flue/runtime@1.0.0-beta.9` | generated agents/profiles pass the real validators; tools, subagent rosters, stable spawn plans, and the reactive workflow execute against the real package |

These pins are intentional. An upstream `main` branch or roadmap issue can
inform design, but it cannot replace a released-package compatibility proof.

## What upstream is converging on

### Cloudflare Agents

The current [Project Think roadmap](https://github.com/cloudflare/agents/issues/1439)
makes Think the default durable agent harness and names recovery, sub-agent
orchestration, multi-chat ownership, tools, workspaces, and fork/handoff as the
main stabilization tracks.

The accepted [sub-agent RFC](https://github.com/cloudflare/agents/blob/main/design/rfc-sub-agents.md)
uses ordinary `Agent` subclasses as named child facets with isolated SQLite and
typed RPC. The accepted
[agent-tool orchestration RFC](https://github.com/cloudflare/agents/blob/main/design/rfc-helper-sub-agent-orchestration.md)
keeps the same child primitive and adds model-chosen `agentTool(...)` plus
imperative `runAgentTool(...)` orchestration.

Two details matter to agent-jsx:

- Cloudflare's [`@callable()` documentation](https://github.com/cloudflare/agents/blob/main/docs/agents/callable-methods.md)
  defines the decorator as client/WebSocket exposure. Agent-to-Agent calls use
  ordinary typed Durable Object RPC and do not require it.
- The multi-chat direction is one child Durable Object per conversation, with a
  parent owning directory/sidebar and explicitly shared resources. Conversation
  messages, memory, extensions, and branch history remain child-local.

Open work includes
[multi-phase chained turns](https://github.com/cloudflare/agents/issues/1386),
[Think + Artifacts handoff](https://github.com/cloudflare/agents/issues/1440),
and other recovery/client-tool details. These are adapter opportunities, not
portable authoring primitives today.

### Flue

Flue's current [agent guide](https://flueframework.com/docs/guide/building-agents/)
defines continuing instances by module name plus application-chosen `id`.
Reusable `defineAgentProfile(...)` values carry instructions, tools, skills,
and subagent roles; public routing and authorization remain application-owned.
The [subagent guide](https://flueframework.com/docs/guide/subagents/) keeps
delegation on named profiles and the session task capability.

Flue's unreleased beta.10 work is explicitly pre-1.0. The
[release discussion](https://github.com/withastro/flue/discussions/494) and
[changelog](https://github.com/withastro/flue/blob/main/CHANGELOG.md) move
direct and dispatched agent admission to a unified `DeliveredMessage`, make
direct prompts asynchronous, and bump the reset-only persisted schema. Those
transport changes do not currently alter the emitted
`defineAgent`/`defineAgentProfile`/`defineWorkflow`/`session.task` surface, but
we will not claim beta.10 compatibility until a release is pinned and tested.

The most relevant open discussions are
[session forking](https://github.com/withastro/flue/discussions/422),
[durable step workflows](https://github.com/withastro/flue/discussions/390),
[private service-binding transport](https://github.com/withastro/flue/discussions/411),
and [per-call tool schemas](https://github.com/withastro/flue/discussions/413).
The Flue issue on
[full agent-instance identity](https://github.com/withastro/flue/issues/496)
also reinforces that durable identity is the pair `(agentName, instanceId)`,
not an instance id alone.

## Portable authoring decisions

### 1. Keep kind identity and instance identity separate

`static agentName` identifies an authored agent kind. The JSX `name` prop
identifies one mounted instance inside a composition. Emitters may combine
these with a parent path, Cloudflare class/facet name, Flue module name, or
Flue instance id, but authored classes must not guess those runtime addresses.

This matches both Cloudflare's `(class, child name)` facet identity and Flue's
`(agentName, instanceId)` execution identity.

### 2. Treat values as data and functions as explicit authority

Serializable props are child input. Functions never enter persisted config.
They must be branded at the composition site, such as
`onTurn={result(handleTurn)}`, and compile to a target-specific capability:

- a generated Durable Object RPC ACL on Cloudflare reconcile;
- explicit result routing around a Cloudflare `agentTool` turn;
- a named profile plus awaited `session.task` result on Flue.

This prevents JSX nesting from silently becoming ambient authority.

### 3. Give `@callable()` a portable meaning

In authored agent-jsx classes, `@callable()` means “this is a public operation
that composition may expose.” It does not mean “send this over WebSocket.”

The Cloudflare emitter also decorates the generated method for clients, while
internal calls remain native DO RPC. A Flue adapter is free to represent the
same authored operation through a task, tool, action, or application route.

### 4. Keep session and transport policy out of component props

Cloudflare Session history, Flue `DeliveredMessage`, HTTP routes, WebSockets,
recovery leases, admission receipts, stream offsets, and authorization are not
portable props. They belong in the deployment adapter or application shell.

This lets Cloudflare adopt chained turns or Artifacts and lets Flue change its
pre-1.0 admission envelope without changing authored agent classes.

### 5. Preserve target-owned state scopes

An authored root's state is durable on the Cloudflare targets. Cloudflare child
DOs/facets may also own isolated state. A generated Flue child profile is a
delegation role, not a mounted child store; the compiler warns when child-local
state or infra cannot be preserved there.

The README must not imply that all three targets share one persistence model.

### 6. Compile dynamic composition; do not serialize it

State-gated JSX is desired state, not a stored closure graph. Cloudflare
reconcile observes/diffs/applies it. Think exposes eligible children as model
tools. Flue emits static profiles plus a deterministic stable-id spawn plan and
workflow loop.

Forking, dynamic tool-schema narrowing inside a model loop, durable workflow
steps, and human approval remain target features until their contracts are
released and independently proven.

### 7. Keep deployment capabilities additive

`getPrompt()`, `getTools()`, and `getSkills()` are portable declarations.
Actions, sandboxes, MCP servers, workspaces, browser tools, credentials, public
routes, and provider resolution are deployment-owned additions. An emitter may
pass through a supported declaration, but it must not invent access from an
agent name or JSX position.

## Known target seams

| Seam | Current position |
|---|---|
| Cloudflare full child DO vs facet | Reconcile mode keeps the proven binding-backed DO model; Think uses native facet-backed `agentTool`. A future reconcile-facet mode should be additive. |
| Cloudflare schedules | Generated reconcile classes use async `listSchedules()`, which is supported for top-level agents and facets; the deprecated synchronous inventory API is not emitted. |
| Cloudflare chained turns/forks | Leave to Think/Session adapters; do not encode synthetic continuation messages in authored props or durable state. |
| Flue direct/dispatch messages | Application adapter concern. Generated profiles and workflows do not manufacture public transport envelopes. |
| Flue child durability | Not equivalent to a mounted Cloudflare child; compiler diagnostics remain mandatory. |
| Dynamic/mid-loop tool schemas | Static tool declarations are portable. Per-call or mid-loop narrowing is target-specific until a stable common contract exists. |
| Reasoning and progress streams | Public, target-defined output. `render()` remains optional UI only and never becomes prompt/control-plane input. |

## Maintenance rule

When an upstream target moves:

1. Pin the new released version in the relevant compatibility package.
2. Run the real validator/workerd suite and record any divergence in
   `COMPAT-REPORT.md`.
3. Change the emitter or adapter before changing authored semantics.
4. Update this note only after the executable baseline is green.
