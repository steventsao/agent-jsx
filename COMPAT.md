# Compat TDD: prove the emitters against the real runtimes

Status: **layers 1–3 GREEN** (see COMPAT-REPORT.md). Cloudflare reconcile is
currently pinned to `agents@0.17.4`; Think is pinned to `agents@0.17.4` plus
`@cloudflare/think@0.13.0`; Flue is pinned to the current published
`@flue/runtime@1.0.0-beta.9`. **v0.5 GREEN** (reactive flue workflow executor —
see COMPAT-REPORT.md #12–#17). **v0.6 GREEN** (method props: request/response RPC
with return values — see COMPAT-REPORT.md #21–#23).

## The three layers

| Layer | Runner | Command | What it proves | Status |
|---|---|---|---|---|
| 1. Unit | bun test | `bun test tests` | parity theorem holds; emitters honor `runtimeImport`; artifact graph is react-machinery-free; wrangler fragment valid | ✅ GREEN |
| 2. cloudflare | vitest-pool-workers (real workerd) | `cd compat/cloudflare && bun install --frozen-lockfile && bun run test` | generated classes run on the REAL `agents` pkg: spawn w/ props, prop-change push, callback→parent dispatch, despawn, idempotent wake | ✅ GREEN |
| 3. flue | Vitest + real `@flue/runtime` | `cd compat/flue && bun install --frozen-lockfile && bun run test` | generated modules satisfy flue's own validators; spawnPlan derives stable-id descriptors | ✅ GREEN |

## Rules of engagement (for whoever makes this green)

1. **Fix emitters/runtime, not tests.** Assertions in `tests/emit.test.ts`, `compat/cloudflare/test/uptime.spec.ts`, `compat/flue/test/flue-compat.test.ts` define the contract. API-shape details inside tests (e.g. `runInDurableObject` typing, how state is seeded) may be adjusted to match the real packages; the BEHAVIOR asserted may not be weakened. If a test encodes a factual mistake about a runtime, fix it and leave a comment citing the runtime source file that proves the correction.
2. **No mocks of `agents` or `@flue/runtime`.** The point is reality.
3. **Real references when APIs disagree with the emitters:**
   - cloudflare/agents source: the pinned `compat/cloudflare/node_modules/agents`
     package plus the upstream repository's `packages/agents`, `packages/think`,
     `docs`, and accepted `design` records. Prefer async `listSchedules()` over
     the deprecated synchronous inventory API.
   - flue source: the pinned `compat/flue/node_modules/@flue/runtime` package is
     the compatibility oracle. Upstream `main`, its changelog, and discussions
     inform forward design but are not a release claim. If a local checkout is
     inspected, treat it as read-only and never run its deploy.
4. **Known open items the tests will force** (expected implementation work):
   - `emitCloudflare(root, children, analysis, { runtimeImport, emitRuntimeTo })` — 4th options arg; rewrite runtime imports; copy a **react-free** runtime file set (evaluate/collect/prompt/store) to `emitRuntimeTo`. This requires splitting `src/reconciler.ts` (react-reconciler dep) so `collectInfra`/`collectPrompt` live in a react-free module, and splitting `src/state.ts` so `createStore`/`withStaticEval` don't import react. Keep root `bun test tests` (parity) green through the split.
   - `emitFlue(opts & { runtimeImport, emitRuntimeTo })`, `emitFlueChild(child, budget, opts)`.
   - Generated CF code likely has real-API mismatches to shake out in workerd: `Agent` generics, `this.name`, schedule payload shape, `setState` semantics inside `runInDurableObject`, callback RPC via `getAgentByName` stubs. Fix in the emitter template.
5. **Git guardrails:** work in `~/dev/agent-jsx` only. Small local commits, present tense. **Never push. Never force-push. Never rebase, squash, or amend existing commits. Never touch any other repo's git state.**
6. Node 20 is the shell default and its corepack/pnpm shim is broken — use `bun` for everything in this repo (bun 1.3.2 installed). The flue checkout itself uses pnpm; run pnpm there via `corepack`? No — use whatever the flue repo's packageManager declares, executed FROM that repo, only if building @flue/runtime is required.

## Definition of done

`bun test tests` green, `compat/cloudflare bun run test` green in real workerd, `compat/flue bun run test` green against the local flue build — plus a short `COMPAT-REPORT.md` documenting every divergence found between the emitters' assumptions and the real runtimes (these are the valuable findings).

---

# v0.5 — the reactive flue workflow executor (GREEN)

**Goal:** flue is the v0.5 deploy target, but flue has no state→render loop. The missing piece is a generated `defineWorkflow` that executes one turn of reactive composition: evaluate the component at state → delegate fresh `spawnPlan` children via `session.task` → fold each result back through that record's own `onResult` closure → repeat until a round adds nothing. Despawn/cancel is explicitly OUT of scope (a completed task can't be unspawned) — that's v1/CF semantics.

**Contract tests (all GREEN):**

| Test | Defines |
|---|---|
| `tests/workflow-executor.test.tsx` | `runReactiveWorkflow` in **`src/workflow-executor.ts`** (react-free; shipped by `emitRuntimeFiles` as `runtime/workflow-executor.ts`). Includes the **v0.5 parity theorem**: byte-identical final state + same delegated stableIds as the live SimHost path; multi-round convergence; loud `maxRounds` throw. |
| `tests/emit-workflow.test.tsx` | `emitFlueWorkflow` in `src/compile/emit-flue.ts`: defineWorkflow wired to the executor with `delegate = session.task`, top-level `v.object` input schema (flue load-time rule), `runtimeImport` honored. |
| `compat/flue/test/workflow.test.ts` | The generated `src/generated/uptime.workflow.ts` loads against real `@flue/runtime` and executes the loop end-to-end (real harness via `@flue/runtime/test-utils` if it runs headless; else a fake harness mirroring the real `session.task(prompt, { agent })` shape with source citation — never fake `@flue/runtime` itself). `compat/flue/scripts/generate.tsx` must emit the workflow module. |

**Rules unchanged:** fix emitters/runtime, never weaken assertions; API-shape corrections in tests require a source citation into `~/dev/flue` (read-only). Verify the emitted workflow against flue's REAL `defineWorkflow` signature (`packages/runtime/src/` — workflow definition module) and conform the emitter; if the executor's return value can't be a workflow return verbatim, adjust the emitted wrapper, not the executor semantics. All previously green layers must stay green, including `bun run all` and the cloudflare compat suite. Extend `COMPAT-REPORT.md` with any new divergences (numbered, cited).

---

# v0.6 — method props: request/response RPC with return values (GREEN)

**Goal:** a function prop is a *capability with a return value*, not just an event. `<Investigator lookupRunbook={(s) => ...} />` must let the child `await props.lookupRunbook(site)` like a local function while the parent's freshest closure computes the answer from parent state. The props a parent passes are the child's capability grant — a declarative ACL over the parent's RPC surface.

**Contract tests (GREEN):**

| Test | Defines |
|---|---|
| `tests/emit-method-props.test.tsx` | Generated child proxies `return await parent.onAgentEvent(...)`; the dispatcher's callback branch returns the invoked closure's awaited result. |
| `compat/cloudflare/test/method-props.spec.ts` | In real workerd: child fires its SLA handler → awaits the runbook method prop → parent closure computes from parent state → finding contains both the runbook text and the parent-state-derived count, never "undefined". |

**Scope notes:** args/returns must be structured-cloneable (document in COMPAT-REPORT). Sim treats children as opaque records and the flue task boundary is one-shot — method props execute on the CF target (and any future live child mount); the flue emitter should note the limitation in its generated comment if touched. Existing gates all stay green; regenerate fixtures (`bun run fixtures`) in the same commit as the template change and let the fixture diff document it. Optionally redeploy `agent-jsx-demo` (`bun scripts/generate-deploy.tsx && bunx wrangler deploy -c wrangler.deploy.jsonc`) and verify `/state` shows a runbook-bearing finding — record the observation in COMPAT-REPORT.
