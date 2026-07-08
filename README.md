# agent-jsx

> [!WARNING]
> **Experimental / WIP / beta — all of it.** This repo is a running research
> experiment, not a supported product. Every surface can and does change
> without notice: the `agentComponent` spec, the intrinsics, the emitters,
> the generated-code contracts, the runtime file set, the wrangler shapes.
> There is no semver yet, no deprecation policy, no support, and no security
> review. The compat suites and the divergence ledger (COMPAT-REPORT.md) are
> honest about what has been proven — treat everything outside them as
> unproven. Do not run this in production; do point it at problems and file
> what breaks.

**A priompt-shaped declarative interface for agents — not a React runtime.** JSX is used the way priompt uses it: a pure function from (props, state) to a *declaration*, rendered to data. priompt declares what enters the context window under a token budget; agent-jsx extends the same stance to the agent's entire world — the capability surface (sensors, schedules, subagents, tools, tasks) *and* the context window are both derived from state by evaluation, then a durable host diffs and applies. Parent→child data is props; function props are capabilities (callbacks and method RPC); everything the runtimes make you hand-write (`getAgentByName` plumbing, RPC stubs, wrangler bindings, migrations, flue profiles) is compiled from the declaration.

```tsx
function UptimeAgent({ sites, store }) {
  const { statuses, findings } = useAgentState(store);
  const down = sites.filter((s) => statuses[s]?.state === "down");

  return (
    <>
      {sites.map((site) => (
        <sensor key={site} name={`ping:${site}`} url={site} interval={2} onStatus={observe(site)} />
      ))}
      {down.map((site) => (
        <subagent key={site} name={`investigate:${site}`} kind="investigator" input={{ site }} onResult={record(site)} />
      ))}
      {down.length > 0 && <tool name="page-oncall" description="Escalate to a human" run={page} />}

      <prompt>
        <sys p={10}>Uptime agent for {sites.length} sites.</sys>
        {down.map((site) => <msg key={site} p={9}>INCIDENT: {site} down. {findings[site] ?? "Investigating."}</msg>)}
        {sites.map((site, i) => <msg key={site} prel={-i - 1}>history: {site} nominal.</msg>)}
      </prompt>
    </>
  );
}
```

A site goes down → state changes → re-render → the reconciler **mounts** an investigation subagent, **mounts** an escalation tool, and the incident **enters the prompt at high priority** (evicting routine history under the token budget). The site recovers → everything unmounts, in-flight work cancelled. Nothing imperative registers or cancels anything. The whole loop is prop changes.

```sh
bun install
bun run all          # deterministic, offline, zero services
```

## Declaring an agent

Every agent — root or child — is declared the same way, by `agentComponent(spec)` in its own component file:

```tsx
export const UptimeAgent = agentComponent<UptimeProps, UptimeState>({
  agentName: "uptime",                            // → class / DO binding / flue profile name
  initialState: { statuses: {}, findings: {} },   // embedded into the generated artifact
  sampleProps: { sites: ["https://a.example"] },  // representative root props for compile-time analysis
  getPrompt: (state) =>                            // optional imperative context window,
    `Watching ${Object.keys(state.statuses).length} sites.`, //   used only when the tree renders no <prompt>
  impl: ({ sites, store }) => {
    /* the render tree: sensors, subagents, tools, and an optional <prompt> */
  },
});
```

The spec is what the compiler statically analyzes — state shape, props, and prompt strategy all live in the component file, with no separate state-type / initial-state / props plumbing threaded through the emitters.

## Premises (sharpened)

1. **JSX is a declarative interface, not a runtime.** A component is a pure function `(props, state) → declaration`. This is priompt's stance — the one JSX-for-LLMs approach that survived — extended from prompt layout to agent composition.
2. **A render produces data: capability records, plus an OPTIONAL context window.** The capability surface — flat records (sensor / schedule / subagent / tool / task), each identified by a mandatory stable `name` — is the core, always present. The context window is optional and has two sources: a `<prompt>` subtree when you want priompt constraints (blocks with `p`/`prel` priorities, assembled under a token budget), or the imperative `spec.getPrompt(state)` think-seam when you just want a string from state. Render neither and the agent simply has no context layer. Nothing else.
3. **There is no lifecycle in the model.** "Mount/unmount" is the HOST's diff of consecutive declarations — create/update/remove by `name`, never by tree position. Effects, durability, retries, journals belong to hosts (cloudflare/agents DOs, flue workflows, CF Workflows steps, the sim). The declaration never executes anything.
4. **React never ships.** The evaluator is ~70 lines; compiled artifacts carry a 15-line JSX *data* runtime (`#agentjsx`). React — types, the live sim, StrictMode discipline — is optional dev tooling, and the parity test proves the two paths byte-identical, which is what licenses shipping without it.
5. **Control flow is JavaScript.** `.map` is fan-out, `if` is a conditional capability, function extraction is composition. No combinator DSL — priompt's move again.
6. **Cross-boundary communication is declared, then scaffolded at build.** Serializable props push down (`setProps` RPC); function props become capabilities (CallbackRefs, request/response method props); bulk data rides bindings (blob refs, #15). The compiler owns the wiring the way it owns wrangler config — once, at build.

The name "fiber" survives as the dev harness's implementation detail (a react-reconciler host powers the live sim), not the model. The model is: evaluate → data → host diff.

## Subagent composition: the actual problem this solves

Composing agents is where both target runtimes are weakest, and where React is strongest:

| | cloudflare/agents today | flue today | as components |
|---|---|---|---|
| parent→child wiring | `getAgentByName(env.BINDING, name)` + hand-typed Env + wrangler bindings + migrations | `subagents: [...]` baked into definitions; DO class/migration naming ceremony | **nesting** — `<Investigator .../>` inside the parent's tree |
| child input | ad-hoc RPC methods you write | task payloads | **props** — serializable props are the child's contract; a parent re-render that changes them compiles to a `setProps` RPC |
| child→parent results | more hand-written `@callable`s | task return values | **callback props** — `onResult={fn}` compiles to a CallbackRef; the child's impl calls an ordinary function, codegen routes it to the parent's dispatcher, which invokes the freshest closure from the latest render |
| lifecycle / identity | manual spawn, manual cleanup, `{ idempotent: true }` bookkeeping | spawn-plan design doc (proposed) | **mount/unmount** under React keys + a mandatory stable `name` |

Declare the boundary once ([examples/investigator.tsx](examples/investigator.tsx)):

```tsx
export const Investigator = agentComponent<InvestigatorProps, InvestigatorState>({
  agentName: "investigator",
  initialState: { checked: [] },
  sampleProps: { site: "https://example.com", since: 0, onResult: () => {} },
  impl: ({ site, since, onResult, store }) => (
    <>
      <tool name="fetch-logs" ... />
      <schedule name="sla-deadline" every={8} onFire={() => onResult(`[${site}] no root cause within SLA`)} />
      <prompt><sys p={10}>You investigate ONE outage: {site}, down since t={since}.</sys></prompt>
    </>
  ),
});
```

Compose it like any component (`examples/uptime-agent.tsx`):

```tsx
{down.map((site) => (
  <Investigator key={site} name={`investigate:${site}`} site={site}
                since={statuses[site]!.since} onResult={record(site)} />
))}
```

`bun ex:compile` then generates, from these two component files:

- **`uptime.cloudflare.ts`** — `UptimeAgentDurable` + `InvestigatorDurable` over a generated `FiberAgentBase`: typed `this.subagent(kind, name)` accessors, `setProps` push, `CallbackRef` proxies, one `onAgentEvent` dispatcher, schedule convergence against `getSchedules()`.
- **`uptime.wrangler.jsonc`** — DO bindings + migrations for every generated class.
- **`uptime.flue.ts` + `investigator.flue.ts`** — parent module (resting prompt → instructions, `spawnPlan(state)` for the dynamic residue — flue's own proposed render-prop shape) + child `defineAgentProfile` (props = task input, callback = task result).
- **`uptime.workflow.ts`** — a flue `defineWorkflow` adapter that runs the reactive trace: evaluate at state → delegate fresh children through the flue harness → fold results through the callback closure → repeat until no new children appear.

## What JSX adds on top of flue

flue already has the right durable execution primitives: `defineAgent`, `defineAgentProfile`, `defineWorkflow`, and `session.task`. What it does not have is a hierarchical desired-state layer. In native flue, the workflow author usually owns the orchestration trace directly: call this task, inspect the result, maybe call the next task, remember what has already been delegated. In agent-jsx, the workflow authoring surface is the component tree, and the generated flue workflow is only the harness adapter.

That difference shows up in ordinary code.

**Conditional fan-out is just data rendering:**

```tsx
{incidents.map((incident) => (
  <Investigator
    key={incident.site}
    name={`investigate:${incident.site}`}
    site={incident.site}
    since={incident.since}
    onResult={(finding) => store.set((s) => ({
      ...s,
      findings: { ...s.findings, [incident.site]: finding },
    }))}
  />
))}
```

The `.map` is the fan-out. The stable `name` is the durable identity. If the same incident is still present on the next render, it is not delegated twice. If another incident appears, the rendered tree has one more child and the host sees one fresh record. The flue target receives this as `spawnPlan(state)` plus the reactive workflow loop; the Cloudflare target receives it as child Durable Object reconciliation.

**Hierarchy scopes capability:**

```tsx
<Investigator
  name={`investigate:${site}`}
  site={site}
  since={statuses[site]!.since}
  onResult={record(site)}
  lookupRunbook={(s) => `restart edge pods for ${s}`)}
/>
```

The parent grants exactly the capabilities it passes as props. Serializable props are child input. Callback props are the child's line back to the parent. Method props are request/response RPC on the Cloudflare target; on flue's one-shot task boundary, the generated child profile keeps the simpler task-input/task-result shape. Either way, the boundary is declared once at the JSX call site instead of being scattered across profile names, harness calls, dispatcher code, and environment bindings.

**Children remain agents, not steps:**

```tsx
export const Investigator = agentComponent({
  agentName: "investigator",
  initialState: { checked: [] },
  impl: ({ site, since, onResult, store }) => (
    <>
      <tool name="fetch-logs" description="Pull recent logs" run={() => `logs(${site})`} />
      <schedule name="sla-deadline" every={8} onFire={() => onResult(`[${site}] still open`)} />
      <prompt>
        <sys p={10}>Investigate {site}, down since t={since}.</sys>
      </prompt>
    </>
  ),
});
```

The parent does not know the investigator's tools, schedules, prompt, or state shape. It only knows the child's props. That is the part flue's flat profile list cannot express by itself: nested ownership with a small typed boundary between agents.

## Flue subagent bindings vs JSX nesting

Native flue declares subagents as named profiles on the parent agent/profile. The name lives on `defineAgentProfile`, not on `defineAgent`; `session.task(text, { agent })` selects one of those declared names.

```ts
export const bboxExtractor = defineAgentProfile({
  name: "bbox-extractor",
  instructions: "Extract one bbox from the PDF page.",
});

export const layoutReviewer = defineAgentProfile({
  name: "layout-reviewer",
  instructions: "Review layout regions; delegate bbox extraction as needed.",
  subagents: [bboxExtractor],
});

export default defineAgent(() => ({
  model: "openrouter/google/gemini-3.1-flash-lite-preview",
  instructions: "Analyze the document layout.",
  subagents: [layoutReviewer],
}));

// Later, in a workflow/session:
await session.task("Review page 1", { agent: "layout-reviewer" });
```

agent-jsx writes the same boundary as component nesting:

```tsx
<LayoutReviewer
  name={`review:${page.id}`}
  page={page}
  onResult={(verdict) => store.set({ verdict })}
/>
```

and emits the flue pieces:

```ts
// layout.flue.ts
import { layoutReviewerProfile } from "./layout-reviewer.flue.ts";

export default defineAgent(() => ({
  model: "...",
  instructions: "...rendered parent prompt...",
  subagents: [layoutReviewerProfile],
}));

// layout-reviewer.flue.ts
export const layoutReviewerProfile = defineAgentProfile({
  name: "layout-reviewer",
  instructions: "...rendered child prompt...",
});

export function spawnPlan(state) {
  return [{ stableId: "review:p1", agent: "layout-reviewer", input: { page } }];
}
```

| Concern | Native flue binding | agent-jsx JSX to flue |
|---|---|---|
| Child declaration | `defineAgentProfile({ name, instructions, subagents })` | `agentComponent({ agentName, impl })` |
| Parent binding | Static `subagents: [profile]` array on `defineAgent` or another profile | Parent renders `<Child name=... />`; compiler emits the child profile and delegation plan |
| Nested children | Profiles can contain their own `subagents: [...]` arrays | Child components can own their own nested components; the boundary is still props/callbacks |
| Instance identity | The profile name selects a reusable delegation target | `name` is the durable instance id; `agentName`/`kind` selects the reusable target |
| Parent → child input | Usually embedded in the task text or structured result prompt | Serializable props become the delegated task input |
| Child → parent result | `session.task(...)` resolves to the child task response | `onResult` is folded through the rendered callback closure; on flue this is still a task return |
| Dynamic presence | The workflow author decides when to call `session.task` | State decides whether `<Child />` renders; the generated workflow delegates fresh stable ids |

So the flue target is not replacing flue's subagent mechanism. It is compiling a nested JSX ownership tree down to flue's existing pieces: named profiles for reusable agent behavior, stable ids for per-incident instances, and a `defineWorkflow` loop that calls `session.task(..., { agent })` when the render reveals new children.

## Human input as topology

The document review example is the more product-shaped version of this. It waits for a document-channel payload, starts deterministic text-layer extraction over that uploaded PDF, then asks Gemini-labeled attempts for progressively stronger structured reads only when the user clicks **Try harder**. Clicking **OK** freezes the accepted payload and prevents more work.

```tsx
function DocumentReviewAgent({ store }: { store: AgentStore<DocumentReviewState> }) {
  const { source, textLayer, requestedAttempts, candidates, acceptedId } = useAgentState(store);
  const pendingAttempt =
    source && textLayer && !acceptedId && candidates.length < requestedAttempts
      ? candidates.length + 1
      : null;

  return (
    <>
      {source && !textLayer && (
        <task
          name="extract:text-layer"
          run={() => extractTextLayer(b64ToBytes(source.pdfB64), wholePage)}
          onDone={(text) => store.set({ textLayer: String(text) })}
        />
      )}

      {pendingAttempt && (
        <ExtractionAttempt
          name={`extract:attempt-${pendingAttempt}`}
          attempt={pendingAttempt}
          {...modelForAttempt(pendingAttempt)}
          textLayer={textLayer}
          onResult={(candidate) =>
            store.set((s) => ({ ...s, candidates: [...s.candidates, candidate] }))}
        />
      )}
    </>
  );
}
```

The authored client policy is intentionally boring:

```ts
runDocumentReviewAction(state, {
  type: "receiveDocument",
  channel: "document",
  document: { name, pdfB64 },
}); // replaces review state with a new source from the channel
runDocumentReviewAction(state, { type: "tryHarder" }); // increments requestedAttempts if allowed
runDocumentReviewAction(state, { type: "ok" });        // stores acceptedId if a candidate is waiting
```

That is the difference from a normal workflow button. The upload and buttons do not enqueue hard-coded next steps. They change durable state. The next render decides whether extraction or another child agent exists.

The deployable button UI is generated from that source. The generation package mirrors flue's "author source, generate app surface" shape:

```sh
bun compile:document-review
```

That runs [`compat/document-review/scripts/generate.tsx`](compat/document-review/scripts/generate.tsx), which emits:

- `src/generated/document-review.cloudflare.ts` — root + extraction-attempt Durable Object classes from the JSX composition.
- `src/generated/document-review.api.ts` — generated HTTP routes, typed browser client, and the HTML page with PDF upload, **Try harder**, and **OK** controls.
- `src/generated/runtime/*` — the React-free JSX/evaluation runtime used by the generated classes.

The Worker entrypoint only re-exports generated code:

```ts
export { DocumentReviewDurable, ExtractionAttemptDurable } from "./generated/document-review.cloudflare.ts";
export { default } from "./generated/document-review.api.ts";
```

Run it:

```sh
bun ex:document-review
cd compat/document-review && bun run test
```

The same pattern maps cleanly onto the frontend surfaces in neighboring systems:

| Surface | What it gives the app | Where agent-jsx adds leverage |
|---|---|---|
| [flue `@flue/react` + `@flue/sdk`](https://flueframework.com/docs/guide/react/) | `FlueProvider`, `useFlueAgent()` for continuing conversations, `useFlueWorkflow()` for finite runs, and SDK calls like `client.workflows.invoke(...)` / `client.runs.stream(...)` | The workflow or agent input can be "set review state"; JSX render turns that state into the exact extraction attempt boundary to run next |
| [CopilotKit `useAgent` / AG-UI](https://github.com/CopilotKit/CopilotKit) | Shared state, generative UI, and human-in-the-loop controls inside the product UI | The shared state is not only chat/UI state; it is also the desired capability graph: tasks, tools, schedules, and child agents appear/disappear from the same state |
| agent-jsx generated API | `emitCloudflareClientApi()` emits instance routes under `/agents/document-review/:id/*` (`/api/state`, `/api/channels/document`, `/api/try-harder`, `/api/ok`), a browser client, and the page; the Worker delegates through `routeAgentRequest()` | A testable UX contract: document input arrives through a channel, invalid clicks are rejected by the authored reducer, double-clicking cannot queue duplicate attempts, and accepting unmounts the work surface |

So the claim is narrow: agent-jsx is not trying to out-client Flue or CopilotKit. It gives those clients a better backend shape to control: human input mutates state, and declarative agent composition decides what durable work should exist next.

## State ownership by target

The authoring pattern is intentionally local: each agent component is written against `props` and its own `store`; composition is the only place where a parent binds child props and callbacks. The compiler validates that boundary in two directions:

| Question | Validation | Current answer |
|---|---|---|
| Does the parent render child internals? | `tests/component-boundary.test.tsx` evaluates a parent and asserts it records only `subagent:<name>`, not the child's tools/schedules/prompt | No. Parent composition records only the boundary: `kind`, stable `name`, serializable props, callback handlers |
| Can the child run by itself from props and its own state? | The same test evaluates the child implementation directly with `sampleProps + createStore(initialState)` | Yes. The child owns its prompt, tools, schedules, and state reads/writes |
| Does Cloudflare preserve child state? | `emitCloudflare` emits one Durable Object class per `agentComponent`; child `setProps` and callback refs are generated RPC | Yes. Child `AgentStore` maps to that child DO's persisted state |
| Does flue preserve child state? | `flueChildTargetDiagnostics()` inspects the child component; `tests/target-diagnostics.test.tsx` locks the warning | Not as a mounted child runtime today. The flue target emits a task profile: props become task input, `onResult` is the task result, and child `initialState` is only used to render profile instructions |
| How does the user see target gaps? | `emitFlueChild()` embeds `TARGET WARNING [...]` comments in generated child profiles | The generated artifact says when child-local state or child infra cannot be emitted for flue |

That is the UX line: component organization stays clean, but target semantics are not pretended. If a target cannot carry a stateful child boundary, the compiler must say so in structured diagnostics and in the generated artifact.

## The reactive flue trace

The generated flue workflow gives the flue target a dynamic-workflow-like capability without asking authors to write workflow combinators. The trace is deterministic:

```
input state
  │
  ▼
render component over a local merging store
  │
  ▼
collect desired subagents [{ stableId, agent, input, onResult }]
  │
  ▼
delegate only fresh stableIds via session.task(text, { agent })
  │
  ▼
fold each task result through that record's onResult closure
  │
  ▼
render next round; no fresh children? return final state + prompt
```

For the uptime demo, a flue workflow turn enters with `b.example` already down:

| Round | Render sees | Fresh delegated work | Result fold | Next render |
|---|---|---|---|---|
| 1 | `statuses["https://b.example"].state === "down"` | `investigate:https://b.example` via `{ agent: "investigator" }` | `onResult` writes `findings["https://b.example"]` | prompt now includes the finding |
| 2 | same incident, same stable child name | none — already delegated | none | workflow returns |

The same loop handles multi-stage dynamic plans because the next render can reveal new children:

```tsx
function IncidentResponse({ store }: { store: AgentStore<State> }) {
  const { rootCause, ticket } = useAgentState(store);
  return (
    <>
      {!rootCause && (
        <subagent name="diagnose" kind="diagnoser" onResult={(r) => store.set({ rootCause: r })} />
      )}
      {rootCause && !ticket && (
        <subagent name="escalate" kind="escalator" onResult={(r) => store.set({ ticket: r })} />
      )}
    </>
  );
}
```

Trace:

| Round | State entering render | Fresh child | Result changes |
|---|---|---|---|
| 1 | `{ rootCause: null, ticket: null }` | `diagnose` | `rootCause = "done:diagnose"` |
| 2 | `{ rootCause: "done:diagnose", ticket: null }` | `escalate` | `ticket = "done:escalate"` |
| 3 | `{ rootCause: "...", ticket: "..." }` | none | return |

That is the "dynamic workflow" property: the workflow graph is discovered by repeatedly rendering the agent's desired state after each child result. It stays hierarchical because each child can itself be an agent component with its own prompt and capabilities. It stays declarative because the generated workflow loop is generic; the policy is still the JSX conditions and props.

## Different from dynamic workflows and Code Mode

Claude Code [dynamic workflows](https://code.claude.com/docs/en/workflows) and Cloudflare [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) both move orchestration into code. agent-jsx does that too, but at a different layer: the code is a durable component declaration, not a per-task script or a model-generated tool plan.

| Axis | agent-jsx JSX composition | Claude Code dynamic workflows | Cloudflare Code Mode |
|---|---|---|---|
| Primary job | Define a long-lived agent topology: state, prompt, tools, schedules, sensors, child agents | Run one large task by spawning many subagents from a workflow script | Let a model write code that calls tools/API methods inside a sandbox |
| Who writes the orchestration | A human or agent authors TSX components; the compiler emits runtime adapters | Claude writes a JavaScript workflow script for the requested task; saved workflows can be rerun | The model writes a code snippet against typed connectors or discovered APIs |
| Unit of composition | Agent components with props, callback props, method props, and stable `name` identity | `agent()` calls, `pipeline(...)`, loops, script variables, phases | One code-execution tool plus typed methods such as connector calls |
| When the graph changes | Every render over persisted state can reveal a new desired child, tool, schedule, or prompt block | The script decides what to spawn next while the run is active | The generated snippet branches/loops during one tool execution |
| Where intermediate state lives | Durable agent state plus child agent state; prompt is re-rendered from state | Workflow script variables and the workflow run record | Sandbox local variables and returned values |
| Hierarchy | Structural: parent owns children; children can be full agents with their own prompts/tools/schedules | Operational: one workflow coordinates many peer subagents for a task | API-shaped: code composes tool calls, not durable agent ownership |
| Identity and idempotence | Mandatory stable `name`; host reconciles create/update/remove by desired state | The workflow runtime tracks a run and its spawned agents | The runtime records executions, but tool calls are not agent mounts |
| Best fit | Deployed agents whose capability surface changes with state over time | Codebase audits, large migrations, research, verification sweeps | Large tool/API surfaces where direct tool calls would burn context and round trips |
| What "dynamic" means | Re-render after each state/result fold; new children appear declaratively | Script loop/branching spawns more agents as the task evolves | Generated code loops/branches over tool results inside one execution |
| Output surface | Live worker endpoints like `/state` and `/prompt`, plus generated artifacts | Final report/result and workflow progress UI | A shaped return value from the code execution |

There is a naming collision with this repo's planned `/codemode` endpoint ([docs/agent-first-cli.md](docs/agent-first-cli.md)): that endpoint means "show the deployed agent's source, generated module, wrangler fragment, and fixtures." It is a lineage/export surface for another agent to inspect and fork. It is not Cloudflare Code Mode's model-writes-code execution pattern, though it is compatible with that direction: Code Mode gives an agent a compact way to call a large API, while agent-jsx gives an agent a compact source artifact for a durable agent topology.

## Compilation is sound because React is redundant at runtime

`bun ex:compile` first proves parity: the real React render+commit path and a ~70-line React-free element walker produce **byte-identical** desired infra and prompt text. That works because components are pure functions of (props, state) — no effects, and the one hook degenerates to a store read — and because the host re-derives *full* desired state each commit, diffing by `(kind, name)`; React's incremental fiber diffing buys nothing for a few dozen infra nodes. So React is the **dev-time** environment (StrictMode, keys, tests, the mental model, live sim), and the shipped artifact is plain actor code. It also splits static vs dynamic capability by partial evaluation at sample states — static infra is deploy-time config, dynamic infra is the state-gated residue.

## Where this sits (and why it isn't the thing that failed)

The sibling repo [`agents-as-components`](https://github.com/steventsao/agents-as-components) established the three-verdict split: JSX-as-declaration ✅, React-as-*execution*-runtime ❌ (GenSX shipped it, recanted, archived; StrictMode double-fires paid LLM calls in effects), React-as-surface ✅.

agent-jsx is built strictly inside the ✅ lanes, and adds one move the analysis pointed at but nobody claimed:

> **React never executes an agent step here.** No LLM call lives in render or effects. Render *declares* — which capabilities should exist, what the context window should contain — and the commit reconciles that declaration against a durable host. Execution belongs to the host (a Durable Object, a workflow engine, a sandbox). The model is the control flow *inside* one node; React is the control plane *between* nodes.

That respects the bright line from flue's own design docs ("agents are stateful actors with identity and side effects... It's `Array.map(spawn)`, not `ReactDOM.render`"). The useful residue of React is smaller and sharper than "the reconciler": **declaration-diffing by stable identity under changing data** — which the host does by `name`, and which is precisely the unsolved chore in agent runtimes today. The react-reconciler appears only inside the dev sim.

## Two-level reconciliation

```
props/state change
   │ render (pure — StrictMode-safe, double-render proof in rehydrate.tsx)
   ▼
element tree ──React diff (keys = identity)──► commit
                                                 │ resetAfterCommit: one sweep
                                                 ▼
                                    desired infra [{kind, name, config}]
                                                 │ host diff by (kind, name)
                                                 ▼
                                  + create   ~ update   ↻ rebind   - remove
                                  (idempotent upserts against durable records)
```

The second level is what a UI renderer never needed and an agent runtime can't live without: the fiber tree dies on hibernation, but the host's records persist. Waking up = re-render the same code over persisted state → the sweep **converges** (rebind, zero duplicate creates). [`examples/rehydrate.tsx`](examples/rehydrate.tsx) proves it, and proves StrictMode doubles renders while host ops stay identical.

**Closures are never serialized — they're re-rendered.** `onStatus`/`onResult`/`run` rebind on every commit, exactly like `onClick` in react-dom. Durability of *behavior* comes from code + persisted state, not from persisting functions. This dissolves the "closures don't serialize" objection from the sibling repo's example 07: you don't serialize them; you re-derive them.

## The prompt is a render target too (priompt)

`<prompt>/<sys>/<msg>/<scope>` with `p` (absolute) and `prel` (relative) priorities, assembled under a token budget by cutoff search — [anysphere/priompt](https://github.com/anysphere/priompt)'s model (`src/prompt.ts` is a ~60-line stand-in; swap in the real `priompt` package + tokenizer for production). Because the prompt subtree re-renders from the same state as the infra, **the context window is derived state**: incidents enter at p=9 and evict routine history the moment they exist, and leave when resolved. No hand-managed context accumulation.

## Influences, mapped

| Influence | What it contributed | Where |
|---|---|---|
| [loopy.computer](https://loopy.computer) uptime example | the flagship demo's semantics: poll sensor → incident → investigate → acknowledge. loopy runs it as markdown workflows + typed events; here the same loop is state → render → reconcile | [`examples/uptime.tsx`](examples/uptime.tsx) |
| [cloudflare/agents](https://github.com/cloudflare/agents) | the execution substrate this control plane is designed to sit on. The pkg already fused React idioms with the actor (`setState` broadcast, `useAgent`) — and already fights infra duplication with `schedule(..., { idempotent: true })` options and `onStart()` warnings. Desired-state reconciliation makes that structural | [`docs/cloudflare-adapter.md`](docs/cloudflare-adapter.md) |
| flue `@flue/jsx` + okra `codeframe` | JSX-as-declaration with identity discipline: required stable `name` (host identity) alongside React `key` (tree identity) — the "idempotent stable id" lesson from flue's render-prop plan, enforced at commit | `src/reconciler.ts` (`collectInfra` throws without `name`) |
| [priompt](https://github.com/anysphere/priompt) | the context window as responsive layout under a token viewport | `src/prompt.ts` |
| [agents-as-components](https://github.com/steventsao/agents-as-components) | the boundary conditions: what must never happen (LLM calls in render/effects, reconciler as executor) | `examples/rehydrate.tsx` StrictMode section |

## What's deliberately NOT here

- **No LLM step as a component.** `<Agent prompt=...>` executing a completion is the GenSX/AI.JSX shape that died. The single `think()` seam assembles the rendered prompt and hands it to whatever executes (mock here; `AIChatAgent`/Anthropic in production).
- **No workflow combinators.** Chains/loops of LLM steps belong to durable workflow code (or the sibling repo's interpreter), not to this tree. This tree only declares *standing* capabilities.
- **No effects.** `useEffect` never appears. If you find yourself reaching for it inside an agent component, the thing you're doing is execution and belongs in the host.

## Layout

```
src/reconciler.ts        react-reconciler host (0.31/React 19, cribbed from react-nil)
                         + the post-commit sweep → host.reconcile(desired)
src/agent-component.tsx  agentComponent(): agent boundaries as typed components
src/sim-host.ts          in-memory host + scripted world: diff, ops log, tick,
                         subagent latency, snapshot/restore (hibernation)
src/prompt.ts            priompt-lite: priority cutoff under a token budget
src/state.ts             agent store + useAgentState (+ static-eval mode)
src/agent.ts             mountAgent(): update / tick / prompt / think / unmount
src/compile/evaluate.ts  the React-free element walker (parity-proven)
src/compile/analyze.ts   static/dynamic split via partial evaluation
src/compile/emit-cloudflare.ts  DO classes + subagent/callback glue + wrangler
src/compile/emit-client-api.ts  generated HTTP routes + browser client/page shell
src/compile/emit-flue.ts        flue parent module + child profiles + spawnPlan
examples/uptime-agent.tsx   the parent agent (written once, three consumers)
examples/investigator.tsx   the child agent (props in, callback out)
examples/uptime.tsx         the loopy loop live under React (flagship)
examples/document-review-agent.tsx  human-input review loop over a document-channel PDF
examples/document-review-actions.ts  authored button/action policy
examples/document-review-client.ts  button-shaped client facade (OK / Try harder)
examples/document-review.tsx        runnable trace for the human review loop
compat/document-review/       generated Cloudflare Worker UI/API package
examples/rehydrate.tsx      hibernation convergence + StrictMode op-count proof
examples/compile.tsx        parity proof + static/dynamic split + emit
docs/cloudflare-adapter.md  the production mapping + open problems
```

## Status

Working prototype / research artifact. Compilation dissolved the biggest runtime question (no live React in the DO, no async-reconcile-under-React) — what remains is in [`docs/cloudflare-adapter.md`](docs/cloudflare-adapter.md): the generated reconcile still applies ops sequentially against async CF APIs (needs the convergence-loop treatment), subagent RPC shapes are stubs pending a real deploy, and the flue targets should be validated against a flue checkout.

## Live demo

The fixtures' inputs are deployed as **https://agent-jsx-demo.steventsao.workers.dev** (`compat/cloudflare/scripts/generate-deploy.tsx`: real sites, `intervalScale: 5`, real-fetch sensor probes). Verified unattended on production Cloudflare — sensor probe fails DNS on the `.invalid` site → component policy marks it down → investigator child DO spawns with `__props` + CallbackRefs → the child's own SLA schedule fires → `onResult` RPCs back → the parent folds the finding → `GET /prompt` re-renders with it (COMPAT-REPORT #19). Poke it: `GET /state`, `GET /prompt`, `POST /incident?site=`, `POST /recover?site=`.
