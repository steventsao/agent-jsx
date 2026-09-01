---
"@steventsao/agent-jsx": minor
---

Add the durable leaf: a `<DurableRun>` boundary (with a `durable` host intrinsic and `DurableWorkflowRef`/`DurableRunProps`/`DurableEngineLike` types) that mounts one exactly-once imperative workflow execution, identified by (workflow, payload) so a remounted leaf replays its persisted result instead of re-running. Workflows are authored as plain `run(payload, step)` functions with `step.do` checkpoints; the executing engine (runtime-internal `src/durable.ts`, driven by the Effect workflow engine) powers SimHost, while the Think target reports `durable` records as unsupported and the Cloudflare reconcile target fails loudly pending an `env.WORKFLOW.create()` lowering.
