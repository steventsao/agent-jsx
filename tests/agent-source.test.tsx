import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  compileAgent,
  defineAgentProfile,
  type AgentRenderProps,
} from "../src/agent-component.tsx";
import { emitAgentModule } from "../src/compile/emit-agent-module.ts";
import { evaluateComponent } from "../src/compile/evaluate.ts";
import { collectInfra } from "../src/tree.ts";

interface SourceProps {
  query: string;
  onResult: (answer: string) => void;
}

interface SourceState extends Record<string, unknown> {
  runs: number;
}

const profile = defineAgentProfile<SourceProps, SourceState>({
  name: "source-worker",
  model: "openrouter/openai/gpt-5-mini",
  description: "Answers one query.",
  initialState: { runs: 0 },
  capabilities: { onResult: "result" },
  sampleProps: { query: "sample", onResult: () => {} },
});

function SourceWorker({ query }: AgentRenderProps<SourceProps, SourceState>) {
  return <prompt><msg p={1}>{query}</msg></prompt>;
}

describe("normal agent source modules", () => {
  it("lowers a component + profile to the existing boundary contract", () => {
    const Compiled = compileAgent(SourceWorker, profile);

    expect(Compiled.spec.agentName).toBe("source-worker");
    expect(Compiled.spec.model).toBe("openrouter/openai/gpt-5-mini");
    expect(Compiled.spec.impl).toBe(SourceWorker);
    expect(Compiled.spec.capabilities).toEqual({ onResult: { kind: "result" } });

    const roots = evaluateComponent(Compiled, {
      name: "worker:1",
      query: "hello",
      onResult: () => {},
    });
    expect(roots.flatMap((root) => collectInfra(root))[0]).toMatchObject({
      kind: "subagent",
      name: "worker:1",
      config: { kind: "source-worker", query: "hello" },
      bindings: { onResult: { kind: "result" } },
    });
  });

  it("emits the checked-in chess boundary companions", () => {
    const openai = emitAgentModule({
      sourceImport: "../openai-chess-player.agent.tsx",
      exportName: "OpenAIAgent",
      runtimeImport: "../../../src/agent-component.tsx",
    });
    const gemini = emitAgentModule({
      sourceImport: "../gemini-chess-player.agent.tsx",
      exportName: "GeminiAgent",
      runtimeImport: "../../../src/agent-component.tsx",
    });

    expect(openai).toBe(
      readFileSync(new URL("../examples/chess/generated/openai-chess-player.compiled.tsx", import.meta.url), "utf8")
    );
    expect(gemini).toBe(
      readFileSync(new URL("../examples/chess/generated/gemini-chess-player.compiled.tsx", import.meta.url), "utf8")
    );
  });

  it("rejects invalid generated export names", () => {
    expect(() =>
      emitAgentModule({ sourceImport: "../anything.agent.tsx", exportName: "not-valid-name" })
    ).toThrow("exportName must be a JavaScript identifier");
  });
});
