# Mapping the host to cloudflare/agents

The `AgentHost` boundary compiles to Durable Objects extending `Agent` from the
`agents` package (currently proven against `agents@0.17.4` in real workerd). A
DO already owns the persisted state, schedules, addressability, and
wake/hibernate lifecycle that `SimHost` models.

There are now two deliberate Cloudflare placements: reconcile mode uses
binding-backed child DOs because it needs independently addressable mounted
children and removal convergence; Think mode uses native facet-backed
`subAgent`/`agentTool` runs. Authored agent classes do not select the placement.

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

  onStateChanged() {
    // setState (from a tool call, a client, a schedule firing) → re-render →
    // capability surface + prompt re-derive. Same state also streams to
    // browser `useAgent` clients: one store, two render targets.
    this.fiber?.update(<App state={this.state} agent={this} />);
  }
}
```

## Primitive mapping

| agent-jsx | cloudflare/agents (`0.17.4`) | Notes |
|---|---|---|
| `<schedule name every>` | `this.schedule(...)` / `await this.listSchedules()` / `cancelSchedule(id)` | The generated reconciler structurally diffs desired schedules by stable payload key. It uses the async inventory API because the deprecated synchronous `getSchedules()` cannot cross facet boundaries. |
| `<sensor name url interval>` | a poll `schedule` whose callback fetches + compares, or an inbound route (`onRequest`, email, webhook) | loopy's `@sensor(poll="5m")` is exactly a poll schedule; its webhook sensors are exactly `onRequest`. |
| `<subagent name kind input>` | reconcile: `getAgentByName(env.BINDING, name)` + typed RPC; Think: `subAgent`/`agentTool` facet | Facets require exported classes but no child binding/migration. Current Agents delegates facet schedules to the root owner. The two placements stay separate compile modes. |
| `<tool name description run>` | MCP tool registration (`McpAgent`) or the chat agent's tool list | Mount/unmount = the agent's tool surface changes with state — e.g. `page-oncall` existing only during an incident. |
| `useAgentState` / `store` | `this.state` / `this.setState()` | The generated store supplies merge semantics over Agents' replacement write. Browser state sync and control-plane rendering observe the same durable value. |
| `<prompt>` + `renderPrompt(budget)` | assemble per model turn (`AIChatAgent`, `generateText`, or raw Anthropic call) | Swap the chars/4 estimator for a real tokenizer or the real `priompt` package. |
| hibernation snapshot/restore | free — DO storage persists state + schedules; `onStart` re-mounts | The prototype's "re-arm in-flight subagent work on wake" is what DO alarms / workflow retries already do. |

## Remaining design constraints

1. **Unmount is not hibernation.** Eviction must not tear down durable infra;
   only the desired graph removing a record can do that.
2. **Render stays pure and synchronous.** World reaction enters through state or
   an explicit handler. The async single-flight controller observes, diffs, and
   applies after evaluation.
3. **Placement is target policy.** Binding-backed child DOs and colocated facets
   have different routing, lifecycle, and scale properties. JSX expresses the
   logical boundary, not the placement.
4. **Identity is persisted explicitly.** Request-scoped `this.name` is not a
   safe wake identity. Generated reconcile classes persist their canonical
   instance name before deriving child paths.
5. **Child state is isolated.** Native facets and binding-backed children do not
   automatically participate in the parent's state broadcast. Result/callback
   bindings remain explicit.

See [upstream alignment](upstream-alignment.md) for the current roadmap audit
and the portability boundary shared with Flue.
