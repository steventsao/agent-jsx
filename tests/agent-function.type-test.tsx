/** Compile-time acceptance tests for direct function-component authoring. */

import {
  compileAgent,
  defineAgentProfile,
  type AgentRenderProps,
} from "../src/agent-component.tsx";
import { result } from "../src/agent-class.tsx";

interface QueryProps {
  query: string;
  onResult: (answer: string) => void;
}

interface QueryState extends Record<string, unknown> {
  runs: number;
}

function QueryWorker({ query }: AgentRenderProps<QueryProps, QueryState>) {
  return <prompt>{query}</prompt>;
}

const queryProfile = defineAgentProfile<QueryProps, QueryState>({
  name: "query-worker",
  model: "sim/query",
  initialState: { runs: 0 },
  sampleProps: { query: "sample", onResult: () => {} },
  capabilities: { onResult: "result" },
});

const Worker = compileAgent(QueryWorker, queryProfile);

<Worker name="w:1" query="q" onResult={result((answer: string) => answer.length)} />;

// @ts-expect-error query is required by the authored component contract.
<Worker name="w:1" onResult={result(() => {})} />;

// @ts-expect-error every function prop needs an explicit capability declaration.
defineAgentProfile<QueryProps, QueryState>({
  name: "query-worker",
  model: "sim/query",
  initialState: { runs: 0 },
  sampleProps: { query: "sample", onResult: () => {} },
});

const wrongProfile = defineAgentProfile<{ other: string }, QueryState>({
  name: "wrong-worker",
  model: "sim/query",
  initialState: { runs: 0 },
  sampleProps: { other: "sample" },
});

// @ts-expect-error the profile must match the function's direct prop contract.
compileAgent<QueryProps, QueryState>(QueryWorker, wrongProfile);

function Team({ store }: AgentRenderProps<{}, { answer: string | null }>) {
  return (
    <Worker
      name="w:2"
      query="q"
      onResult={result((answer) =>
        store.set((state) => ({ ...state, answer })),
      )}
    />
  );
}

// A supervisor keeps the same shape and simply omits model.
export const TeamAgent = compileAgent(
  Team,
  defineAgentProfile<{}, { answer: string | null }>({
    name: "query-supervisor",
    initialState: { answer: null },
    sampleProps: {},
  }),
);
