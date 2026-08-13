# parse-pm — a project manager for a long-running document parse

`ParseAgent` supervises the repo's proven PDF pipeline (ParseBench sample →
fixture layout → per-region text extraction → metered model labeling →
assembly → verification) as a **long-running agent** in the sense of the
Cloudflare doctrine — [Long-running agents](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/)
— with one deliberate addition the doctrine lacks: a **budget**, owned by the
PM the way a project manager owns the checkbook.

Run it offline: `bun run ex:parse-pm` (deterministic scripted world, exit 0).
Prove it on the metal: `cd compat/parse-pm && bun install && bun run test`
(real workerd, real `agents@0.20.1`, fake provider).

## Doctrine → code

| CF doctrine term | Where it lives here |
|---|---|
| **Agents are durable identities, not processes** | `compat/parse-pm/src/worker.ts` — `ParsePmAgent extends Agent` (agents 0.20.1). Its identity is the DO name; its memory is SQLite-backed agent state (`ParsePmState`) plus DO storage for the doc. The eviction specs kill the live instance (`DurableObjectState#abort`) and prove the identity carries on. |
| **Structured plan** (recovery context AND approval surface) | `PARSE_GOAL_TABLE` in `parse-agent.tsx` — a flat, serializable goal table folded from the `<Phase>` declarations: `ingest ▶ layout ▶ extract ▶ assemble ▶ verify ▶ done`, with `extract —budget_exhausted→ paused —topped_up→ extract`. `GET /status` returns the plan + phase + spend + checkpoint — exactly what a human reviews before topping up. `analyzeGoal` checks it statically before anything mounts. |
| **Checkpoint BEFORE expensive work** | The `classify` grant in `parse-agent.tsx`: before every metered provider call it writes `{phase, completedRegions+results, spentUsd, callCount}` into state and pushes it through the durable `persist` port (worker: `setState` (SQLite) + `fiber.stash`). The event-order test (`tests/parse-pm.test.tsx`) proves `persist:N` strictly precedes `call:region`. |
| **Recover from the last checkpoint** | Resume = re-drive from persisted state. The composition itself skips completed regions (they are simply not `pending`), so recovery is idempotent by construction — the durable `ledger` is the call-count oracle (never a duplicate region across pause, eviction, or fiber recovery). |
| **Hibernation / wake (schedule, alarms)** | The drive runs inside `this.runFiber("parse-drive", …)` — the real agents primitives: `keepAlive` held for the duration, `stash()` checkpoints on the fiber row, and an eviction mid-call leaves an *interrupted* row that the agents runtime detects on the next wake, calling `onFiberRecovered`, which re-drives. Proven in `compat/parse-pm/test/parse-pm.spec.ts` ("eviction MID-DRIVE"). |
| **Sub-agents for delegation** | One `RegionExtractor` child per pending region, mounted by the `extract` phase. Children are dumb dispatchers: input `{regionId}`, three grants, zero knowledge of the graph, the doc, the budget, or each other. |
| **Human-in-the-loop gate** | `paused` is a PHASE that mounts only a gate task. The bearer-guarded `POST /topup` raises the budget (the write half); the gate task notices the new checkbook and dispatches `topped_up` (the machine half). Waiting-for-human is state, not an exception. |
| **The gap the doctrine leaves: budget** | The PM's `classify` grant is the ONLY path to the provider. It debits a flat per-call ceiling *before* calling, meters real spend from the provider's own `usage` fields after (OpenRouter `usage.cost` live; scripted numbers in tests), and refuses an overdraft by dispatching `budget_exhausted` — a transition, not a throw. Children never hold credentials. |

## The three requirements, and how each is proven

**Budget** — refusal at the exact region boundary (`$0.025` affords
title+authors at real usage `$0.017`; the `$0.01` ceiling refuses
abstract-left), machine parks at `paused`, checkpoint names the paid regions;
after top-up the provider log shows exactly one call per region, ever.

**Privacy** — attenuated grants: `readRegion` is a ZERO-ARG capability with
the bbox bound parent-side (the receipt-crop pattern); `classify` is
PM-mediated; the audit trail (`played` in the driver, `lastPlayed` in worker
status) records exactly what crossed each boundary, and tests grep it for pdf
bytes, bboxes, and credential material (a decoy key in the fake provider makes
the credential grep falsifiable). A stale grant cannot spend the checkbook
(`stale_grant` refusal) and a late report cannot move the machine (reducer
`stale`).

**Checkpoints** — durable before every metered call commits; eviction between
drives and eviction mid-call both resume from the checkpoint without rework;
replay from the JSON round-trip of the paused state folds to byte-identical
final state; final segments deep-equal `fixtures/pdf/golden-segments.json`
(and a shifted bbox cannot reproduce them — the oracle bites).

## Files

- `parse-agent.tsx` — the PM: state, checkpoint, checkbook, goal declaration, root component.
- `region-extractor.tsx` — the dumb child and its three-capability contract.
- `ports.ts` — the equipment seam (`ingest`/`layout`/`pageItems`/`model`/`persist`), sync-or-async by design.
- `fake-provider.ts` — scripted usage numbers + the decoy credential.
- `drive.ts` — the react-free step loop (evaluate → one unit of mounted work → re-evaluate) and the child transport that plays a record through its granted handlers only.
- `demo.tsx` — the scripted end-to-end story: exhaustion, pause, stale late report, top-up, resume-without-rework, golden.
- `../../tests/parse-pm.test.tsx` — the contract (22 tests).
- `../../compat/parse-pm/` — the metal: worker, routes, UI, and the workerd eviction proofs.
