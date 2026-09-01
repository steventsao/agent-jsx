# agent-jsx

**Compose durable AI agents with typed JSX.**

`agent-jsx` lets you define an agent once, compose it like a component, and
compile the same tree to Cloudflare Agents. Models, durable state, and prompts
stay inside the agent definition; data and authority cross boundaries
explicitly as typed props.

> Experimental: APIs may change while the package is in alpha.

[API reference](https://steventsao.github.io/agent-jsx/api/) ·
[Goal example](examples/goal/) ·
[Chess example](examples/chess-goal/) ·
[Cloudflare Think target](docs/think-target.md)

## Install

```sh
bun add @agent-jsx/core@alpha react@^19
```

Use React's automatic JSX runtime for `.tsx` files:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```

## Example

An agent is an ordinary PascalCase function component — direct props in, a
direct JSX return — with its durable identity, model, and initial state
declared in an explicit `profile` beside it:

```tsx
// researcher.agent.tsx
import { defineAgentProfile } from "@agent-jsx/core/agent-component";

interface ResearcherProps {
  question: string;
  onAnswer: (answer: string) => void;
}

export const profile = defineAgentProfile<ResearcherProps, { runs: number }>({
  name: "researcher",
  model: "openrouter/openai/gpt-5-mini",
  initialState: { runs: 0 },
  sampleProps: { question: "", onAnswer: () => {} },
  capabilities: { onAnswer: "result" },
});

export default function Researcher({ question }: ResearcherProps) {
  return (
    <prompt>
      <sys p={10}>Answer with one concise finding.</sys>
      <msg p={7}>{question}</msg>
    </prompt>
  );
}
```

That is the whole authored file. The compiler owns the boundary: it generates
a tiny companion that re-exports `Researcher` under the same name, lowered
through `compileAgent(...)` — that is the import composition sites use:

```tsx
// generated/researcher.compiled.tsx — generated, do not edit
import ResearcherDefinition, { profile } from "../researcher.agent.tsx";
import { compileAgent } from "@agent-jsx/core/agent-component";

export const Researcher = compileAgent(ResearcherDefinition, profile);
```

`emitAgentModule({ mode: "function", ... })` produces this companion; see the
[goal generator](examples/goal/generate.tsx) for a complete invocation. A
supervisor is the same authored shape with `model` omitted:

```tsx
// research-team.agent.tsx
import { result } from "@agent-jsx/core/agent";
import { defineAgentProfile, type AgentRenderProps } from "@agent-jsx/core/agent-component";
import { Researcher } from "./generated/researcher.compiled.tsx";

export const profile = defineAgentProfile<{}, { answer: string | null }>({
  name: "research-team",
  initialState: { answer: null },
  sampleProps: {},
});

export default function ResearchTeam({ store }: AgentRenderProps<{}, { answer: string | null }>) {
  return (
    <Researcher
      name="researcher:primary"
      question="What changed in the latest release?"
      onAnswer={result((answer) =>
        store.set((state) => ({ ...state, answer })),
      )}
    />
  );
}
```

### State drives the tree

Agent state is declarative too. Read it with `useAgentState`, update it with
`store.set` (the durable equivalent of `setState`), and return the tools and
prompt that should exist for that state:

```tsx
// draft-agent.agent.tsx
import {
  defineAgentProfile,
  type AgentRenderProps,
} from "@agent-jsx/core/agent-component";
import { useAgentState } from "@agent-jsx/core/state";

interface DraftProps {
  topic: string;
}

interface DraftState extends Record<string, unknown> {
  mode: "draft" | "review";
}

export const profile = defineAgentProfile<DraftProps, DraftState>({
  name: "draft-agent",
  model: "openrouter/openai/gpt-5-mini",
  initialState: { mode: "draft" },
  sampleProps: { topic: "Why are typed agent boundaries useful?" },
});

export default function DraftAgent({
  topic,
  store,
}: AgentRenderProps<DraftProps, DraftState>) {
  const { mode } = useAgentState(store);
  const setMode = (next: DraftState["mode"]) =>
    store.set((state) => ({ ...state, mode: next }));

  if (mode === "draft") {
    return (
      <>
        <tool
          name="submit-draft"
          description="Submit the current draft for review."
          run={() => {
            setMode("review");
            return "Draft submitted.";
          }}
        />
        <prompt>
          <sys p={10}>Draft a concise answer, then call submit-draft.</sys>
          <msg p={7}>{topic}</msg>
        </prompt>
      </>
    );
  }

  return (
    <>
      <tool
        name="request-revision"
        description="Return the answer for another drafting pass."
        run={() => {
          setMode("draft");
          return "Revision requested.";
        }}
      />
      <prompt>
        <sys p={10}>Review the answer critically before accepting it.</sys>
        <msg p={7}>{topic}</msg>
      </prompt>
    </>
  );
}
```

Calling `submit-draft` persists `mode: "review"`. The next render removes that
tool, adds `request-revision`, and replaces the drafting prompt with the review
prompt. `useAgentState` subscribes during React development and reads the same
durable store in compiled runtimes. Ordinary React `useState` is local and is
not durable agent state.

The contract is deliberately small:

- The component is ordinary React grammar: direct props in, JSX out.
- The profile seals reusable identity, model, initial state, and metadata —
  explicit, never inferred from the export or filename.
- `name` identifies a mounted durable instance.
- Plain props are serializable input.
- Function props cross only through an explicit grant such as `result(...)`.
- JSX owns composition; nesting alone never grants authority.

For long-running work, `<Phase>` declares transitions as data. See the
[repo keeper](examples/goal/repo-keeper.tsx) for a compact loop and
[parse-pm](examples/parse-pm/) for checkpoints, budgets, recovery, and a human
approval gate.

## Verify

```sh
bun install --frozen-lockfile
bun run test:all
```

The full gate runs the package checks, fixture byte-lock, examples, and all
seven compatibility packages serially, then prints one summary. Its example
suite runs in a disposable copy, so generator drift is reported without
writing to the working tree. Use `bun run ci` while iterating on the root
package only.

The compatibility suites execute generated code against pinned Cloudflare
runtimes in workerd. See [COMPAT.md](COMPAT.md) for supported contracts and
[CONTRIBUTING.md](CONTRIBUTING.md) for release workflow details.
