import { z } from "zod";
import { Agent, compileAgentClass } from "../../../src/agent-class.tsx";
import { agentComponent } from "../../../src/agent-component.tsx";

interface ClassWorkerInput {
  query: string;
}

// Deliberately target-neutral rather than Zod: the compatibility suite proves
// emitThink adapts the public throwing parse(value) contract to AI SDK v6.
const classWorkerInput = {
  parse(value: unknown): ClassWorkerInput {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { query?: unknown }).query !== "string" ||
      !(value as { query: string }).query
    ) {
      throw new Error("query must be a non-empty string");
    }
    return value as ClassWorkerInput;
  },
};

// A non-idempotent transform catches accidental child+parent double parsing.
const classWorkerOutput = z
  .object({ answer: z.string().min(1) })
  .transform(({ answer }) => ({ answer: `${answer}::validated-once` }));

class ClassWorkerAgent extends Agent<
  Record<string, never>,
  ClassWorkerInput
> {
  static agentName = "class-worker";
  initialState = {};

  render() {
    return this.define({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      description: "Answer one class-authored delegated query.",
      inputSchema: classWorkerInput,
      outputSchema: classWorkerOutput,
      prompt: (
        <prompt>
          <sys>Answer only the delegated query.</sys>
          <msg>Class worker query: {this.props.query}</msg>
        </prompt>
      ),
    });
  }
}

export const ClassWorker = compileAgentClass(ClassWorkerAgent);

export const ClassCoordinator = agentComponent({
  agentName: "class-coordinator",
  model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  initialState: {},
  impl: () => (
    <>
      <prompt><sys>Delegate the user's query to the class worker.</sys></prompt>
      {ClassWorker({ name: "class-worker", query: "compile-time sample query" }) as any}
    </>
  ),
});
