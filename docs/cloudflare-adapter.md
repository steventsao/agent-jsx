# Mapping the host to cloudflare/agents

The prototype's `AgentHost` boundary is designed to be implemented by a Durable Object extending `Agent` from the `agents` package (checked against agents@0.8.5, `~/dev/cloudflare-agents-playground/packages/agents/src/index.ts`). The DO already owns everything the SimHost simulates — persisted schedules, persisted state, addressable children, a wake/hibernate lifecycle.

## The shape

```ts
import { Agent } from "agents";

export class FiberAgent extends Agent<Env, State> {
  private fiber?: Fiber;

  onStart() {
    // Wake = re-render the same code over persisted state. The commit sweep
    // reconciles against durable records, so this is idempotent by
    // construction — no `{ idempotent: true }` bookkeeping in user code.
    this.fiber = createFiber(new CfHost(this), logOps);
    this.fiber.update(<App state={this.state} agent={this} />);
  }

  onStateUpdate() {
    // setState (from a tool call, a client, a schedule firing) → re-render →
    // capability surface + prompt re-derive. Same state also streams to
    // browser `useAgent` clients: one store, two render targets.
    this.fiber?.update(<App state={this.state} agent={this} />);
  }
}
```

## Primitive mapping

| agent-jsx | cloudflare/agents (0.8.5) | Notes |
|---|---|---|
| `<schedule name every>` | `this.schedule(when, callback, payload, { idempotent })` / `getSchedules()` / `cancelSchedule(id)` | The pkg already ships the exact problem this solves: cron schedules are "idempotent by default", delayed ones need `{ idempotent: true }`, and `schedule()` inside `onStart()` logs a warning about "accumulating duplicate rows across Durable Object restarts". A reconciler replaces that per-call vigilance with a structural diff: desired schedules vs `getSchedules()`, create/cancel the difference. |
| `<sensor name url interval>` | a poll `schedule` whose callback fetches + compares, or an inbound route (`onRequest`, email, webhook) | loopy's `@sensor(poll="5m")` is exactly a poll schedule; its webhook sensors are exactly `onRequest`. |
| `<subagent name kind input>` | `getAgentByName(env.BINDING, name)` + RPC to start; RPC cancel/`destroy()` on removal. Facets are the in-DO alternative | Note the pkg's own constraint: facets can't schedule — "Schedule from the parent agent instead." A parent-owned reconciler is already the natural shape. |
| `<tool name description run>` | MCP tool registration (`McpAgent`) or the chat agent's tool list | Mount/unmount = the agent's tool surface changes with state — e.g. `page-oncall` existing only during an incident. |
| `useAgentState` / `store` | `this.state` / `this.setState()` | Identical semantics; the browser's `useAgent` hook subscribes to the same state. The symmetry is the point: the DO renders its control plane from state; the browser renders UI from the same state. |
| `<prompt>` + `renderPrompt(budget)` | assemble per model turn (`AIChatAgent`, `generateText`, or raw Anthropic call) | Swap the chars/4 estimator for a real tokenizer or the real `priompt` package. |
| hibernation snapshot/restore | free — DO storage persists state + schedules; `onStart` re-mounts | The prototype's "re-arm in-flight subagent work on wake" is what DO alarms / workflow retries already do. |

## Open problems (in honesty order)

1. **Async reconciliation.** `reconcile()` is sync in the prototype; on CF every op is async (`getSchedules`, `schedule`, RPC). The commit sweep must enqueue ops and a convergence loop must apply them — a Kubernetes-controller shape (observe → diff → apply, retry until settled). React's commit stays sync; the host becomes eventually consistent. Races (sensor fires mid-apply) need the queue to be serialized per agent — the DO's single-threaded execution model actually helps here.
2. **Unmount ≠ hibernate.** Eviction must NOT tear down infra (no unmount on hibernation); only an explicit `unmount()` reconciles to ∅. The prototype encodes this: process 1 in `rehydrate.tsx` never unmounts.
3. **Bundle weight.** react + react-reconciler in a Worker is roughly 150–200KB minified — fine for paid Workers limits, worth measuring before believing.
4. **Render discipline.** Render must stay pure and sync (no Suspense, no async components). All world-reaction goes through state; all mutation goes through the commit sweep. This is a constraint the linter can't enforce yet.
5. **Schedule identity.** The pkg dedupes cron by (callback, expression, payload); the reconciler wants dedup by `name`. Carry `name` in the payload, or keep a name→id map in DO storage.
