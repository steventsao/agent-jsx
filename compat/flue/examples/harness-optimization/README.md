# Optimizing a Flue workspace harness with Ax

This offline example keeps execution native to Flue and uses Ax only around the
whole episode:

```text
Ax candidate map
  -> named harness overlay
  -> fresh Flue workspace + session
  -> native model/tool loop
  -> trusted workspace verifier
  -> score + normalized trace back to Ax
```

The authored contract is an ordinary named object. It has no Ax prediction
nodes and no anonymous slots:

```ts
const harness = {
  model,
  prompt: { instructions, task },
  tools: { read, bash, task },
  mcpServers: {},
  skills: {},
  agents: {},
  workspace: { root, files: { "AGENTS.md": guidance } },
  sandbox: { kind: "in-memory-bash", network: "disabled" },
  permissions: { read, write, protected },
  maxTurns: 4,
};
```

Only `harness.workspace.files["AGENTS.md"]` is exposed to Ax. Model routing,
tool capabilities, MCP bindings, sandbox policy, permissions, the task fixture,
and the verifier remain frozen. Every candidate is mounted before Flue
initializes so `AGENTS.md` participates in Flue's normal workspace discovery.

This proof implements the named `read` and `bash` tools, applies their harness
descriptions, and replaces Flue's default workspace tools with that set. A
filesystem policy beneath both tools enforces the file-content read allowlist,
including shell commands such as `cat`; links that could alias an unreadable
file are disabled. Writes happen only in the ephemeral in-memory filesystem;
the trusted verifier rejects protected, disallowed, or out-of-root changes.
The MCP, skill, and agent maps are intentionally frozen empty here, and the
runner rejects non-empty values instead of pretending to support them.

The example is an optimizer-plumbing smoke test: it uses a deterministic faux
model and deterministic Ax proposer so it runs without credentials or network
access. The faux model derives its target and content from the `TASK.md` tool
result, then runs through Flue's real agent loop and invokes real `read` and
`bash` tools, including a final read-back before completion.
Ax's mock AI never handles an agent prediction. For a real optimization, remove
`propose_new_texts` and configure Ax's student/teacher reflection models; the
Flue episode adapter does not change.

From `compat/flue`:

```sh
bun run example:harness-optimize
bun run eval:harness
bun run eval:harness:ui
```

The first command prints the selected Ax component map and baseline/optimized
scores. The eval command uses `vitest-evals` to write `vitest-results.json`; the
UI command serves that local report.

`createFlueContext` is currently Flue's smallest exported direct-runner seam,
but it lives under `@flue/runtime/internal`. This compatibility example pins the
runtime version and keeps that dependency inside `episode.ts` so it can be
replaced when Flue exposes a public direct episode runner.
