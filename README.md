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
bun add @steventsao/agent-jsx@alpha react@^19
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

Define a sealed worker, then grant its result to a durable supervisor:

```tsx
import { result } from "@steventsao/agent-jsx/agent";
import { agent } from "@steventsao/agent-jsx/agent-component";

interface ResearcherProps {
  question: string;
  onAnswer: (answer: string) => void;
}

const Researcher = agent<ResearcherProps, { runs: number }>({
  name: "researcher",
  model: "openrouter/openai/gpt-5-mini",
  state: { runs: 0 },
  props: { question: "", onAnswer: () => {} },
  capabilities: { onAnswer: "result" },
  render: ({ props }) => (
    <prompt>
      <sys p={10}>Answer with one concise finding.</sys>
      <msg p={7}>{props.question}</msg>
    </prompt>
  ),
});

export const ResearchTeam = agent<{}, { answer: string | null }>({
  name: "research-team",
  state: { answer: null },
  props: {},
  render: ({ store }) => (
    <Researcher
      name="researcher:primary"
      question="What changed in the latest release?"
      onAnswer={result((answer) =>
        store.set((state) => ({ ...state, answer })),
      )}
    />
  ),
});
```

The contract is deliberately small:

- `agent()` seals reusable identity, model, initial state, and prompt.
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
bun run ci
```

The compatibility suites execute generated code against pinned Cloudflare
runtimes in workerd. See [COMPAT.md](COMPAT.md) for the supported contracts and
[CONTRIBUTING.md](CONTRIBUTING.md) for release workflow details.
