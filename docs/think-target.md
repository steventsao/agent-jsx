# Cloudflare model-driven target

`emitThink` is the complete lowering for an authored class definition. It emits
one `@cloudflare/think` `Think<Env>` subclass per agent on top of Cloudflare
Agents. The model drives tool use and delegation; the generated class owns
durable chat, state, recovery, and streaming.

An authored `Agent.render()` is not application UI. It synchronously returns one
branded declaration:

```tsx
render() {
  return this.define({
    model: "openrouter/openai/gpt-5-mini",
    description: "Review one document.",
    inputSchema: reviewInputSchema,
    outputSchema: reviewOutputSchema,
    prompt: <prompt><msg>{this.props.document}</msg></prompt>,
    tools: { inspect },
    skills: [reviewSkill],
    mcpServers: {
      docs: {
        url: "https://mcp.example.com/docs",
        transport: "streamable-http",
      },
    },
  });
}
```

Hierarchy remains separate composition JSX. A definition does not declare that
an agent is a parent or child, and the compiler never infers provider, role, or
authority from its name.

## Definition mapping

| Rendered field | Generated Cloudflare behavior |
|---|---|
| `model` | `getModel()`; optionally passed through a deployment `modelResolver` |
| `prompt` | `getSystemPrompt()` without skills; with skills, `beforeTurn()` composes the live authored prompt with Think's Session skill catalog |
| `inputSchema` | validates native `agentTool` input, which is then bound as the child's current definition props |
| `outputSchema` | parses and validates the child's structured result returned to the parent model |
| AI SDK `tools` map | re-derived for each `getTools()` call while each tool object and its metadata remain intact |
| declarative `<tool>` | converted to an AI SDK tool with the freshest render closure |
| `skills` | `getSkills()` returning structural Cloudflare `SkillSource` values |
| `mcpServers` | reconciled in `onStart()` through Cloudflare Agents' MCP client |
| child boundary | `agentTool(ChildDurable, ...)`, named by its slot or child kind |
| description and schemas | retained on generated child-tool boundaries |

Think merges its base tools, skills, MCP tools, and generated child tools for the
turn. agent-jsx rejects duplicate authored/generated tool names instead of using
last-write-wins authority.

The current Bun-driven emitter can load custom/importable `SkillSource`
implementations and sources created with `skills.fromManifest(...)`. It cannot
resolve the Vite-only `agents:skills` virtual module, and it cannot construct an
env-bound `skills.r2(...)` source during generation.

When `children` come from `discoverAgents(...)`, forward each graph node's
`analysis` on its Think child descriptor. The emitter uses that per-child,
multi-sample result both to register state/prop-gated grandchildren as native
tools and to report every unsupported record. Omitting it is supported for
manual descriptors, but falls back to one representative render.

## Deployment-owned provider and MCP adapters

Model ids remain explicit in source. When a provider needs its own package or
secret, the emitter can import deployment glue:

```ts
import { emitThink } from "@agent-jsx/core/compile/cloudflare";

emitThink(root, children, analysis, {
  modelResolver: {
    importPath: "../model-runtime.ts",
    exportName: "resolveDeploymentModel",
  },
});
```

The generated method calls
`resolveDeploymentModel(this.env, Agent.spec.model)`. The chess deployment uses
this seam for its explicit `openrouter/` ids; ids handled by Think's built-in
provider may remain strings.

Authored MCP descriptors intentionally contain only:

```ts
interface McpServerDefinition {
  url: string;
  transport?: "auto" | "streamable-http" | "sse";
}
```

They do not accept headers, OAuth callbacks, or a per-server timeout. Public
endpoint, transport, and OAuth callback selection can live behind `mcpResolver`
rather than in generated source:

```ts
emitThink(root, children, analysis, {
  mcpResolver: {
    importPath: "../mcp-runtime.ts",
    exportName: "resolveMcpServer",
  },
  mcpConnectionTimeoutMs: 10_000,
});
```

The resolver receives `(env, serverName, authoredDescriptor)` and may select a
public URL override, transport, OAuth callback host/path, and non-secret
`configRevision` at runtime. It must never return authentication headers or
other bearer material. Cloudflare Agents `0.20.1` persists MCP transport
options, so reading a token from `env` and placing it in resolver output would
persist that token too. Route authenticated MCP traffic through a
credential-terminating proxy or service that injects the upstream secret.

Runtime validation accepts callback hosts only as credential-free HTTP(S)
origins and callback paths only as plain absolute paths without query or
fragment. Authored and resolved MCP URLs reject fragments and credential-like
query keys. Unknown resolver fields are rejected instead of ignored.

`configRevision` lets a deployment request reconnection after its public
endpoint, transport, or callback configuration changes without putting secrets
or secret-derived hashes in compiler-owned state. `mcpConnectionTimeoutMs`
controls Think's aggregate readiness wait; it is not a field on an individual
authored server.

Server record keys are stable identities. The compiler applies Cloudflare's
server-id normalization, rejects collisions, removes stale persisted
connections, and registers missing or publicly reconfigured servers during
generated `onStart()`. The compiler-owned cleanup lifecycle remains on every
generated Think class so a deployment that removes its final MCP declaration
can still remove only connections recorded in the ownership table. Compilation
itself performs no provider or MCP network I/O.

## Two Cloudflare execution modes

| Concept | Deterministic reconcile (`emitCloudflare`) | Model-driven (`emitThink`) |
|---|---|---|
| generated base | `FiberAgentBase extends Agent` | `ThinkAgentBase extends Think` |
| execution loop | render, diff, and converge desired infrastructure | Think inference and tool loop |
| prompt | available through `promptFor()` | `getSystemPrompt()` without skills; live `beforeTurn()` composition with Session skill context when skills are present |
| model and AI SDK tools | inert, with a generated diagnostic | generated `getModel()` and `getTools()` |
| skills and MCP | inert, with a generated diagnostic | importable Think skills and Agents MCP clients |
| child boundary | standing child DO plus prop/callback RPC | per-call `agentTool` child facet |
| function capability binding | callback/method/result/continuation RPC | unsupported with a specific diagnostic; child output returns to the parent model |
| schedules and sensors | durable convergence | unsupported by this model-driven lowering |

The reconcile emitter remains useful for deterministic sensors, schedules,
tasks, child state, and callback RPC. It deliberately does not become a hidden
chat runtime merely because an authored class has a model definition.

`<sensor>`, `<schedule>`, and one-shot `<task>` records therefore produce loud
`think-*-unsupported` diagnostics in model-driven output. They belong in the
reconcile loop or in explicitly authored Cloudflare lifecycle code.

## Delegation

A tool-slot composition such as:

```tsx
<Coordinator name="coord">
  {(handleCall) => <Worker name="w" onCall={handleCall} />}
</Coordinator>
```

generates `CoordinatorDurable.getTools().onCall` as
`agentTool(WorkerDurable, ...)`. A normally nested child uses its sanitized agent
kind as the tool name. The child description, display name, input schema, and
output schema remain referenced from the imported component spec. After the
native boundary validates an object input, the generated child binds it to
`this.props` before re-rendering the definition. The delegated values therefore
reach that child's prompt and live tool declarations rather than appearing only
as a chat message.

Zod and other Standard Schema inputs pass through to AI SDK v6. The public
target-neutral boundary also accepts a throwing `parse(value)` validator;
generated Think code adapts that shape to an AI SDK schema while preserving its
validation behavior.

The generated `runTurnWithTrace(input, props)` bridge binds the current
composition props for one durable Think turn and returns public text and
reasoning streams. Reasoning is data a UI may consume; authored `render()` never
renders that UI.

Native `agentTool` returns the child's schema-validated output to the parent
model. The child JSON-decodes its final text and the parent tool applies the
output schema exactly once, so transforming schemas are not run twice. It does
not preserve callback, method, `result(...)`, or render-prop continuation grants;
the emitter reports each dropped capability kind explicitly.

## Legacy Flue boundary

`emitFlue` and its profile/workflow helpers remain in the repository for the
existing low-level `agentComponent` fixtures. They still model Flue's profile,
roster, tool, and `session.task` conventions where those adapters are already
covered.

This class-rendered definition work adds no Flue lowering for model, AI SDK tool
objects, skills, or MCP servers and makes no Flue 2 compatibility promise. Ideas
such as explicit tool rosters informed the Cloudflare design, but target
contracts stay separate.

## Compatibility proof

The current compatibility packages pin:

- `agents@0.20.1`
- `@cloudflare/think@0.15.1`

`compat/think` generates model-driven classes and type-checks a full-definition
fixture containing a model, prompt, dynamic AI SDK tool, structural skill, and
MCP declaration. Its real-workerd tests prove:

1. generated Think Durable Objects boot through `getAgentByName`;
2. `getSystemPrompt()` re-renders component context for definitions without
   skills;
3. skill-bearing definitions compose the latest authored state with Think's
   live Session skill catalog in `beforeTurn()`;
4. slot children register as native `agentTool` entries;
5. state-gated AI SDK tools retain their schema, execution function, and
   structured result across renders;
6. `runTurnWithTrace()` preserves public text and reasoning;
7. a mock model can call generated child tools, bind schema-validated native
   input—including the public parse-only validator shape—as the child
   definition's props, and receive exactly-once transformed structured output;
   and
8. generated MCP startup rejects invalid callback persistence settings before
   attempting an external connection, while no-MCP startup exercises the SQL
   ownership and cleanup path.
