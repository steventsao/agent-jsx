import { describe, expect, it } from "bun:test";

import {
  compileAgent,
  defineAgentProfile,
  type AgentRenderProps,
} from "../src/agent-component.tsx";
import { createStore } from "../src/store.ts";
import {
  UnresolvedGeneratedAgentError,
  compileGeneratedAgentManifest,
  makeCompiledAgentRuntime,
} from "../src/compile/generated-runtime.ts";

interface ChildProps {
  topic: string;
}

function Child({ topic }: AgentRenderProps<ChildProps, {}>) {
  return <prompt>Research {topic}</prompt>;
}

const ChildAgent = compileAgent(
  Child,
  defineAgentProfile<ChildProps, {}>({
    name: "child",
    model: "test/child",
    initialState: {},
    sampleProps: { topic: "sample" },
  }),
);

function Supervisor({ store }: AgentRenderProps<{}, { topic: string }>) {
  return <ChildAgent name="child:one" topic={store.get().topic} />;
}

const SupervisorAgent = compileAgent(
  Supervisor,
  defineAgentProfile<{}, { topic: string }>({
    name: "supervisor",
    initialState: { topic: "layers" },
    sampleProps: {},
  }),
);

const rootModule = {
  spec: SupervisorAgent.spec,
  exportName: "SupervisorAgent",
  importPath: "./supervisor.tsx",
};
const childModule = {
  spec: ChildAgent.spec,
  exportName: "ChildAgent",
  importPath: "./child.tsx",
};

describe("JSX to generated runtime lowering", () => {
  it("infers provides/requires from authored React functions", () => {
    expect(compileGeneratedAgentManifest(rootModule, [childModule])).toEqual({
      root: "supervisor",
      agents: [
        {
          provides: "supervisor",
          requires: ["child"],
          exportName: "SupervisorAgent",
          importPath: "./supervisor.tsx",
        },
        {
          provides: "child",
          requires: [],
          exportName: "ChildAgent",
          importPath: "./child.tsx",
        },
      ],
    });
  });

  it("starts inferred resources once and keeps authored renders synchronous", async () => {
    const events: string[] = [];
    const runtime = await makeCompiledAgentRuntime(rootModule, [childModule], {
      child: {
        acquire: () => events.push("acquire:child"),
        release: () => {
          events.push("release:child");
        },
      },
      supervisor: {
        acquire: () => events.push("acquire:supervisor"),
        release: () => {
          events.push("release:supervisor");
        },
      },
    });
    try {
      const rendered = runtime.render("supervisor", {
        store: createStore({ topic: "effect" }),
      });
      expect(rendered).not.toBeInstanceOf(Promise);
      expect(events.filter((event) => event.startsWith("acquire:"))).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(2);
  });

  it("fails closed when JSX names an unregistered child kind", () => {
    expect(() => compileGeneratedAgentManifest(rootModule, [])).toThrow(
      UnresolvedGeneratedAgentError,
    );
  });
});
