# Cloudflare `agentTool` contract

This note records the current contract used by the model-driven compiler target.
The compatibility workspace pins `agents@0.20.1` and
`@cloudflare/think@0.15.1`; generated output is type-checked and exercised
against those packages in real workerd.

## What `agentTool` means

`agentTool(ChildClass, options)` exposes a Cloudflare Agent subclass as an AI SDK
tool. The child must implement the chat/agent-tool adapter supplied by
`@cloudflare/think` or another compatible Cloudflare chat agent. A bare
deterministic `Agent` subclass is not enough.

The tool options carry the child-facing contract:

- `description` and `displayName` describe the delegation target;
- `inputSchema` validates model input before it crosses the child boundary; and
- `outputSchema` validates the structured child result returned to the parent.

During a turn, Think combines the agent's own `getTools()` result with session,
skill, MCP, client, and generated child tools. agent-jsx therefore emits child
boundaries into `getTools()` and rejects duplicate names instead of silently
overwriting one capability with another.

## Why the model-driven target extends `Think`

`Think<Env>` extends Cloudflare's durable `Agent` and owns the model loop:

- `getModel()` selects a string model id or AI SDK model;
- `getSystemPrompt()` supplies the rendered context window when no skills are
  declared; skill-bearing classes compose the live authored prompt with the
  Session skill catalog in `beforeTurn()`;
- `getTools()` supplies authored and child tools;
- `getSkills()` supplies structural Cloudflare `SkillSource` values;
- the Agents MCP client contributes connected MCP tools; and
- durable chat APIs own messages, recovery, streaming, and child-tool runs.

That is the runtime counterpart of a class-authored `render()` definition. The
compiler maps the declaration onto these hooks; the authored method itself is
not UI and is never installed as a Cloudflare rendering callback.

## Reconcile is a different execution contract

`emitCloudflare` emits `FiberAgentBase extends Agent` for deterministic desired
infrastructure. It converges schedules, sensors, tasks, standing child Durable
Objects, state, props, and callback RPC. It does not run an inference loop.

Consequently, a complete class definition is operational only in the
model-driven target. Reconcile output leaves model execution, AI SDK tool maps,
skills, and MCP clients inert and emits a diagnostic explaining that boundary.
The rendered prompt remains available through its explicit `promptFor()` seam.

This separation avoids two unsafe shortcuts:

1. enabling a model merely because a class happens to declare one; and
2. treating a standing child Durable Object and a per-tool-call child facet as
   interchangeable lifecycles.

## Props, schemas, and results

A tool-slot handle is created by composition, not by agent naming. Given:

```tsx
<Coordinator name="coord">
  {(handleCall) => <Worker name="w" onCall={handleCall} />}
</Coordinator>
```

the parent tool is named `onCall`, because that is the explicitly granted prop
key. A plain nested child is named by its sanitized agent kind. The child spec
remains the source of schema and descriptive metadata.

After `agentTool` validates an object input, the generated child binds that
object as its current `this.props` before re-rendering the definition. Prompt
and tool logic therefore receive the delegated fields directly, including
after child-facet recovery.

Generated children return structured output through Think's agent-tool result
hook. The child hook JSON-decodes the final text without applying the authored
contract; `agentTool` validates and transforms that value exactly once at the
parent model boundary. This matters for non-idempotent schema transforms.

That output is returned to the parent model. Native `agentTool` does not expose
parent-owned callback or method functions to the child, invoke a callable
attached through `result(...)`, or persist `__emit` output for a render-prop
continuation. The model-driven emitter reports every such dropped binding with
a target diagnostic.

The target-neutral boundary contract also accepts a throwing `parse(value)`
validator. AI SDK v6 does not accept that shape directly, so generated Think
code wraps it in an AI SDK schema while retaining validation. Native AI SDK and
Standard Schema objects such as Zod pass through unchanged.

## Authored tools, skills, and MCP

AI SDK tool objects returned from `this.define({ tools })` stay live by
reference, preserving their schemas, execution functions, approval metadata,
and structured results. The surrounding map is re-derived from the current
definition whenever Think asks for tools. Declarative `<tool>` nodes remain the
smaller description/run convenience form.

Skills must implement Cloudflare's structural `SkillSource` contract. The
Bun-driven generator currently supports custom/importable sources and
`skills.fromManifest(...)`. It cannot load the Vite-only `agents:skills`
virtual module or construct an env-bound `skills.r2(...)` source.

MCP definitions contain only stable names, HTTP URLs, and optional transports.
An emitted `mcpResolver` may choose a public URL, transport, OAuth callback
host/path, and non-secret `configRevision`. It must not return authorization
headers or bearer material: `agents@0.20.1` persists MCP transport options.
Authenticated MCP endpoints therefore need a credential-terminating proxy or
service that injects upstream secrets without handing them to the Agents MCP
client.

Generated runtime validation requires callback hosts to be credential-free
HTTP(S) origins and callback paths to be plain absolute paths. Authored and
resolved server URLs reject fragments and credential-like query keys. Every
generated Think class retains the compiler-owned cleanup lifecycle, even after
its final MCP declaration is removed; only servers recorded in the compiler's
ownership table are removed.

Think automatically merges connected MCP tools into its inference tool set. No
compiler-authored imitation of that merge is required.

## Verification

The contract is covered at three levels:

1. root tests assert the generated source shape, diagnostics, collision checks,
   and class-definition type failures;
2. `compat/think` type-checks the generated full-definition and MCP lifecycle
   against the pinned Cloudflare packages; and
3. real-workerd tests execute native `agentTool`, schema-validated child input
   bound as live definition props (including a parse-only schema adapter),
   dynamic AI SDK tools, current-state prompt composition with the Session
   skill catalog, exactly-once transformed child output, MCP callback rejection,
   and public text/reasoning traces with mock models.

Cloudflare references:

- <https://developers.cloudflare.com/agents/runtime/execution/agent-tools/>
- <https://developers.cloudflare.com/agents/api-reference/think/>

## Flue scope

The repository's existing Flue emitters remain legacy low-level adapters. Flue
ideas around explicit profiles and tool rosters helped clarify the capability
model, but this `agentTool` implementation does not claim new Flue lowering or
Flue 2 compatibility.
