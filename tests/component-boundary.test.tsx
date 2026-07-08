import { describe, expect, it } from "bun:test";
import { agentComponent } from "../src/agent-component.tsx";
import { evaluateComponent, evaluateTree } from "../src/compile/evaluate.ts";
import { renderPrompt } from "../src/prompt.ts";
import { collectInfra, collectPrompt } from "../src/tree.ts";
import { createStore, useAgentState, type AgentStore } from "../src/state.ts";

interface ParentState extends Record<string, unknown> {
  result: string | null;
}

interface ChildProps extends Record<string, unknown> {
  label: string;
  onResult: (value: string) => void;
}

interface ChildState extends Record<string, unknown> {
  checked: string[];
}

const Child = agentComponent<ChildProps, ChildState>({
  agentName: "child-worker",
  initialState: { checked: [] },
  sampleProps: { label: "sample", onResult: () => {} },
  impl: ({ label, onResult, store }) => {
    const { checked } = useAgentState(store);
    return (
      <>
        <tool
          name="child-tool"
          description="Child-owned tool"
          run={() => {
            store.set((s) => ({ ...s, checked: [...s.checked, label] }));
            return "tool-ran";
          }}
        />
        <prompt>
          <sys p={10}>Child {label}</sys>
          <msg p={8}>Checked: {checked.join(",") || "none"}</msg>
        </prompt>
        <schedule name="child-deadline" every={5} onFire={() => onResult(`done:${label}`)} />
      </>
    );
  },
});

function Parent({ store }: { store: AgentStore<ParentState> }) {
  return (
    <Child
      name="child:alpha"
      label="alpha"
      onResult={(result) => store.set((s) => ({ ...s, result }))}
    />
  );
}

describe("agent component boundary", () => {
  it("parent composition records only the child boundary, not child internals", () => {
    const parentStore = createStore<ParentState>({ result: null });
    const parentInfra = evaluateTree(<Parent store={parentStore} />).flatMap((root) =>
      collectInfra(root)
    );

    expect(parentInfra.map((r) => `${r.kind}:${r.name}`)).toEqual(["subagent:child:alpha"]);
    expect(parentInfra.some((r) => r.name === "child-tool")).toBe(false);
    expect(parentInfra.some((r) => r.name === "child-deadline")).toBe(false);

    const boundary = parentInfra[0]!;
    expect(boundary.config.kind).toBe("child-worker");
    expect(boundary.config.label).toBe("alpha");
    expect(typeof boundary.handlers.onResult).toBe("function");
  });

  it("child implementation evaluates independently from props and its own store", async () => {
    const parentStore = createStore<ParentState>({ result: null });
    const parentBoundary = evaluateTree(<Parent store={parentStore} />)
      .flatMap((root) => collectInfra(root))
      .find((r) => r.kind === "subagent")!;

    parentBoundary.handlers.onResult("parent-fold");
    expect(parentStore.get().result).toBe("parent-fold");

    const childStore = createStore<ChildState>({ checked: ["dns"] });
    const childRoots = evaluateComponent(Child.spec.impl, {
      label: "alpha",
      onResult: () => {},
      store: childStore,
    });
    const childInfra = childRoots.flatMap((root) => collectInfra(root));
    const prompt = renderPrompt(collectPrompt(childRoots), 80).text;

    expect(childInfra.map((r) => `${r.kind}:${r.name}`)).toEqual([
      "tool:child-tool",
      "schedule:child-deadline",
    ]);
    expect(prompt).toContain("Child alpha");
    expect(prompt).toContain("Checked: dns");

    const tool = childInfra.find((r) => r.name === "child-tool")!;
    await tool.handlers.run?.({});
    expect(childStore.get().checked).toEqual(["dns", "alpha"]);
    expect(parentStore.get().result).toBe("parent-fold");
  });
});
