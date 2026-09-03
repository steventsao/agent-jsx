---
"@agent-jsx/core": minor
---

Add the durable leaf: a `<DurableRun>` boundary (with a `durable` host intrinsic and `DurableWorkflowRef`/`DurableRunProps`/`DurableEngineLike` types) that mounts one exactly-once imperative workflow execution, identified by (workflow, payload) so a remounted leaf replays its persisted result instead of re-running. Workflows are authored as plain `run(payload, step)` functions with `step.do` checkpoints; the executing engine is published at `@agent-jsx/core/durable` with Effect-free types and powers SimHost, while the Think target reports `durable` records as unsupported and the Cloudflare reconcile target fails loudly pending an `env.WORKFLOW.create()` lowering.
