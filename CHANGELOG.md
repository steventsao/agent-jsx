# @steventsao/agent-jsx

## 0.1.0-alpha.1

### Minor Changes

- [#34](https://github.com/steventsao/agent-jsx/pull/34) [`3cb48f8`](https://github.com/steventsao/agent-jsx/commit/3cb48f8b0c5490f4d53490bba4861b5c29745e9f) Thanks [@steventsao](https://github.com/steventsao)! - Replace the short-lived `agent({ render })` factory with PascalCase function components that return JSX directly and are lowered with an explicit profile through compiler-generated companions.

- [#38](https://github.com/steventsao/agent-jsx/pull/38) [`eb3859d`](https://github.com/steventsao/agent-jsx/commit/eb3859da5c9fc13849bb44006850720e43a11905) Thanks [@steventsao](https://github.com/steventsao)! - Add the durable leaf: a `<DurableRun>` boundary (with a `durable` host intrinsic and `DurableWorkflowRef`/`DurableRunProps`/`DurableEngineLike` types) that mounts one exactly-once imperative workflow execution, identified by (workflow, payload) so a remounted leaf replays its persisted result instead of re-running. Workflows are authored as plain `run(payload, step)` functions with `step.do` checkpoints; the executing engine (runtime-internal `src/durable.ts`, driven by the Effect workflow engine) powers SimHost, while the Think target reports `durable` records as unsupported and the Cloudflare reconcile target fails loudly pending an `env.WORKFLOW.create()` lowering.

- [#36](https://github.com/steventsao/agent-jsx/pull/36) [`125f11c`](https://github.com/steventsao/agent-jsx/commit/125f11c580ed2ee754f6224f58676c06541dc53a) Thanks [@steventsao](https://github.com/steventsao)! - Expose the durable agent state hook and document state-driven prompt and tool rendering.

- [#31](https://github.com/steventsao/agent-jsx/pull/31) [`932eabb`](https://github.com/steventsao/agent-jsx/commit/932eabb5cfa7a0cbc017566e0cb883f8990ec88d) Thanks [@steventsao](https://github.com/steventsao)! - Add the goal layer's language and runtime, dependency-free. The `<phase>` host intrinsic declares a node of a goal's transition graph (it reconciles to no record), with a PHASE-LOCAL outcome vocabulary: `on` keys are bare, child-local outcome names (`done`, `failed`) mapping to target phase names, so two phases can both spend `done` and mean different edges. The `collectPhases` sweep hands the whole graph over as data, and the new `@agent-jsx/core/goal` entrypoint turns it into a runtime: `buildGoalTable` folds collected phases into a flat serializable table (`edges[phase][outcome] -> target`), and `goalReducer` is a pure table lookup over source-attributed events (`{ type, source: { phase, child? }, payload? }`) — an event whose source phase the goal has already left is refused as `stale`, distinguishable from an `unknown` outcome, so late child callbacks cannot corrupt the machine. XState is not involved: it remains a dev-time devDependency for graph analysis and Stately visualization only.

- [#35](https://github.com/steventsao/agent-jsx/pull/35) [`fc99233`](https://github.com/steventsao/agent-jsx/commit/fc99233a5b16e9cd4d256812f0ac3e37868497a0) Thanks [@steventsao](https://github.com/steventsao)! - Move the package from @steventsao/agent-jsx to the @agent-jsx scope as @agent-jsx/core.

- [#29](https://github.com/steventsao/agent-jsx/pull/29) [`f665c8f`](https://github.com/steventsao/agent-jsx/commit/f665c8f7afbb72acbda7b1dbfbf492b78f3def64) Thanks [@steventsao](https://github.com/steventsao)! - Replace class `model`, `description`, `displayName`, `getPrompt`, `getTools`, `getSkills`, and UI-style `render` authoring with synchronous `render() { return this.define(...) }`, covering model, metadata, prompt, tools, skills, MCP servers, and native child input/output schemas. Publish the Cloudflare compiler entrypoint that lowers the complete definition to model-driven Agents.

## 0.1.0-alpha.0

### Minor Changes

- [#17](https://github.com/steventsao/agent-jsx/pull/17) [`dd53665`](https://github.com/steventsao/agent-jsx/commit/dd536655d253ab88bb38becc51ee62f04d2d0175) Thanks [@steventsao](https://github.com/steventsao)! - Publish the first alpha of the typed agent authoring and compilation package.
