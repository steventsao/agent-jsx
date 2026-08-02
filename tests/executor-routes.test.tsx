/**
 * Executor result routing (src/workflow-executor.ts).
 *
 * routeDelegateResult: a structured `{ output }` delegate result is RESERVED
 * for a render-prop continuation — it routes through the boundary's `__emit`
 * binding (present only when the boundary has a continuation, i.e.
 * SpawnDescriptor.emits === true) into the parent's reserved `__outputs`
 * slot. Without that binding the structured value is silently dropped — it is
 * NOT fed to a result callback. Plain (non-structured) results keep routing
 * through the record's own result binding.
 *
 * Also covered: runReactiveStep with no subagent records (descriptor: null),
 * and promptBudget plumbed through both executor entry points.
 */

import { describe, expect, it } from "bun:test";
import { agentComponent } from "../src/agent-component.tsx";
import type { AgentStore } from "../src/store.ts";
import {
  runReactiveStep,
  runReactiveWorkflow,
  type SpawnDescriptor,
} from "../src/workflow-executor.ts";

interface Produced {
  items: string[];
}

const Producer = agentComponent<Record<string, unknown>, Record<string, never>, Produced>({
  agentName: "exec-producer",
  initialState: {},
  impl: () => null,
});

interface S extends Record<string, unknown> {
  note: string;
}

function Parent({ store: _store }: { store: AgentStore<S> }) {
  return (
    <Producer name="p:1">
      {(output) => <subagent name={`consume:${output.items[0]}`} kind="consumer" />}
    </Producer>
  );
}

const outputsOf = (state: S) =>
  (state as { __outputs?: Record<string, unknown> }).__outputs;

describe("routeDelegateResult — structured { output }", () => {
  it("routes through the __emit binding into the parent's reserved outputs slot", async () => {
    const descriptors: SpawnDescriptor[] = [];
    const result = await runReactiveStep<{ store: AgentStore<S> }, S>({
      component: Parent as never,
      props: {} as never,
      initialState: { note: "start" },
      delegate: (d) => {
        descriptors.push(d);
        return { output: { items: ["a"] } };
      },
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      stableId: "p:1",
      agent: "exec-producer",
      emits: true,
      resultBinding: null,
    });
    expect(descriptors[0]?.bindings).toEqual({ __emit: { kind: "continuation" } });
    expect(outputsOf(result.state)?.["p:1"]).toEqual({ items: ["a"] });
  });

  it("a workflow delegates the continuation grandchild on the next round", async () => {
    const result = await runReactiveWorkflow<{ store: AgentStore<S> }, S>({
      component: Parent as never,
      props: {} as never,
      initialState: { note: "start" },
      delegate: (d) =>
        d.stableId === "p:1" ? { output: { items: ["a"] } } : "consumed",
    });

    expect(result.delegated).toEqual(["p:1", "consume:a"]);
    expect(result.rounds).toBe(2);
    expect(outputsOf(result.state)?.["p:1"]).toEqual({ items: ["a"] });
  });

  it("is silently dropped when the record has no __emit binding — never fed to a result callback", async () => {
    interface DState extends Record<string, unknown> {
      value: string | null;
    }
    function NoContinuation({ store }: { store: AgentStore<DState> }) {
      return (
        <subagent
          name="plain"
          kind="worker"
          __agentBindings={{ onResult: { kind: "result" } }}
          onResult={(v: string) => store.set({ value: v })}
        />
      );
    }

    const result = await runReactiveStep<{ store: AgentStore<DState> }, DState>({
      component: NoContinuation as never,
      props: {} as never,
      initialState: { value: null },
      delegate: () => ({ output: "structured" }),
    });

    expect(result.descriptor).toMatchObject({
      stableId: "plain",
      emits: false,
      resultBinding: "onResult",
    });
    expect(result.state.value).toBeNull();
    expect(result.state).toEqual({ value: null });
  });
});

describe("runReactiveStep — no subagent records", () => {
  it("returns descriptor: null, untouched state, and the rendered prompt without delegating", async () => {
    interface DState extends Record<string, unknown> {
      value: string | null;
    }
    function Idle() {
      return (
        <prompt>
          <sys p={10}>idle prompt</sys>
        </prompt>
      );
    }

    const result = await runReactiveStep<{ store: AgentStore<DState> }, DState>({
      component: Idle as never,
      props: {} as never,
      initialState: { value: null },
      delegate: () => {
        throw new Error("must not delegate");
      },
    });

    expect(result.descriptor).toBeNull();
    expect(result.state).toEqual({ value: null });
    expect(result.prompt).toBe("[system] idle prompt");
  });
});

describe("promptBudget plumbing", () => {
  interface DState extends Record<string, unknown> {
    value: string | null;
  }
  const sys = "s".repeat(40); // 10 tokens
  const msg = "u".repeat(40); // 10 tokens
  function Chatty() {
    return (
      <>
        <subagent name="w" kind="worker" />
        <prompt>
          <sys p={10}>{sys}</sys>
          <msg p={5}>{msg}</msg>
        </prompt>
      </>
    );
  }
  const base = {
    component: Chatty as never,
    props: {} as never,
    initialState: { value: null } as DState,
    delegate: () => "ok",
  };

  it("runReactiveStep renders the final prompt under promptBudget", async () => {
    const tight = await runReactiveStep<{ store: AgentStore<DState> }, DState>({
      ...base,
      promptBudget: 10,
    });
    expect(tight.prompt).toBe(`[system] ${sys}`);

    const loose = await runReactiveStep<{ store: AgentStore<DState> }, DState>(base);
    expect(loose.prompt).toBe(`[system] ${sys}\n${msg}`);
  });

  it("runReactiveWorkflow renders the final prompt under promptBudget", async () => {
    const tight = await runReactiveWorkflow<{ store: AgentStore<DState> }, DState>({
      ...base,
      promptBudget: 10,
    });
    expect(tight.prompt).toBe(`[system] ${sys}`);
    expect(tight.rounds).toBe(1);

    const loose = await runReactiveWorkflow<{ store: AgentStore<DState> }, DState>(base);
    expect(loose.prompt).toBe(`[system] ${sys}\n${msg}`);
  });
});
