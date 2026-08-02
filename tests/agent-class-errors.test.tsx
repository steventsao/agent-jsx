/**
 * Class-authoring error paths and the pieces of src/agent-class.tsx +
 * src/callable.ts the happy-path suite never exercises:
 *
 *   - compileAgentClass requires a static agentName and a model, loudly;
 *   - invokeCallable refuses methods not decorated with @callable();
 *   - composeAgent requires a function child;
 *   - before __bind, state/setState work against DETACHED state (initialState
 *     fallback, then an accumulated private copy); binding a store shadows it;
 *   - normalizeTools: the `run` alias, entries without execute/run dropped,
 *     non-object values dropped, JSX passed through untouched;
 *   - callableNames walks the full prototype chain up to Agent;
 *   - callable() itself only decorates methods, in both decorator protocols.
 */

import { describe, expect, it } from "bun:test";
import {
  Agent,
  callable,
  compileAgentClass,
  composeAgent,
} from "../src/agent-class.tsx";
import { evaluateComponent } from "../src/compile/evaluate.ts";
import { collectInfra } from "../src/tree.ts";
import { createStore } from "../src/store.ts";

interface CounterState extends Record<string, unknown> {
  count: number;
}

class CounterAgent extends Agent<CounterState, { step: number }> {
  static agentName = "counter";
  model = "test/counter-model";
  initialState: CounterState = { count: 0 };

  helper(x: number) {
    return x * 2;
  }

  @callable()
  declared(x: number) {
    return x + 1;
  }

  bump() {
    this.setState((s) => ({ count: s.count + this.props.step }));
  }
}

const Counter = compileAgentClass(CounterAgent);

describe("compileAgentClass — authoring requirements", () => {
  it("throws without a static agentName", () => {
    class AnonymousAgent extends Agent<CounterState> {
      model = "test/model";
      initialState: CounterState = { count: 0 };
    }
    expect(() => compileAgentClass(AnonymousAgent as never)).toThrow(
      "[agent-jsx] Agent class needs static agentName"
    );
  });

  it("throws without a model", () => {
    class ModellessAgent extends Agent<CounterState> {
      static agentName = "modelless";
      // Satisfies the abstract member at compile time while staying undefined
      // at runtime — the compileAgentClass check is what fires.
      declare model: string;
      initialState: CounterState = { count: 0 };
    }
    expect(() => compileAgentClass(ModellessAgent as never)).toThrow(
      '[agent-jsx] Agent class "modelless" needs model'
    );
  });
});

describe("invokeCallable — the callable() gate", () => {
  it("refuses an undecorated method", () => {
    const store = createStore<CounterState>({ count: 0 });
    expect(() => Counter.spec.invokeCallable("helper", { step: 1 }, store, [2])).toThrow(
      '[agent-jsx] "counter.helper" is not decorated with callable()'
    );
  });

  it("refuses a method that does not exist at all", () => {
    const store = createStore<CounterState>({ count: 0 });
    expect(() => Counter.spec.invokeCallable("missing", { step: 1 }, store, [])).toThrow(
      '[agent-jsx] "counter.missing" is not decorated with callable()'
    );
  });
});

describe("composeAgent — root shape", () => {
  it("throws when the root child is not a function", () => {
    expect(() => composeAgent(<Counter name="c" step={1} />)).toThrow(
      "[agent-jsx] composeAgent root needs a function child"
    );
  });
});

describe("Agent — detached state before binding", () => {
  it("falls back to initialState and empty props before __bind", () => {
    const agent = new CounterAgent();
    expect(agent.state).toEqual({ count: 0 });
    expect(agent.props as Record<string, unknown>).toEqual({});
  });

  it("setState before __bind accumulates in detached state", () => {
    const agent = new CounterAgent();
    agent.setState({ count: 5 });
    expect(agent.state).toEqual({ count: 5 });

    agent.setState((s) => ({ count: s.count + 1 }));
    expect(agent.state).toEqual({ count: 6 });
  });

  it("binding a store shadows detached state and routes setState into it", () => {
    const agent = new CounterAgent();
    agent.setState({ count: 5 }); // detached — discarded by the bind

    const store = createStore<CounterState>({ count: 100 });
    agent.__bind(store, { step: 2 });
    expect(agent.state).toEqual({ count: 100 });
    expect(agent.props).toEqual({ step: 2 });

    agent.bump();
    expect(store.get()).toEqual({ count: 102 });
  });
});

describe("normalizeTools — object map edge cases", () => {
  class ToolboxAgent extends Agent<Record<string, never>> {
    static agentName = "toolbox";
    model = "test/toolbox-model";
    initialState = {};

    getTools() {
      return {
        runner: { description: "run alias", run: () => "ran" },
        executor: { description: "execute alias", execute: () => "executed" },
        bare: { execute: () => "no description" },
        noCallable: { description: "missing execute/run" },
        scalar: 42,
        absent: null,
        text: "not a tool",
      };
    }
  }

  it("keeps execute/run entries (run as alias, empty-string default description); drops the rest", () => {
    const Toolbox = compileAgentClass(ToolboxAgent);
    const roots = evaluateComponent(Toolbox.spec.impl, {
      store: createStore<Record<string, never>>({}),
      emit: () => {},
    });
    const tools = roots.flatMap((root) => collectInfra(root));

    expect(tools.map((t) => `${t.kind}:${t.name}`).sort()).toEqual([
      "tool:bare",
      "tool:executor",
      "tool:runner",
    ]);

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.runner?.handlers.run?.({})).toBe("ran");
    expect(byName.executor?.handlers.run?.({})).toBe("executed");
    expect(byName.runner?.config.description).toBe("run alias");
    expect(byName.bare?.config.description).toBe("");
  });

  it("passes declarative <tool> JSX through untouched", () => {
    class JsxToolsAgent extends Agent<Record<string, never>> {
      static agentName = "jsx-tools";
      model = "test/jsx-tools-model";
      initialState = {};

      getTools() {
        return <tool name="direct" description="declared" run={() => "ok"} />;
      }
    }
    const JsxTools = compileAgentClass(JsxToolsAgent);
    const roots = evaluateComponent(JsxTools.spec.impl, {
      store: createStore<Record<string, never>>({}),
      emit: () => {},
    });

    expect(roots.flatMap((root) => collectInfra(root))).toMatchObject([
      { kind: "tool", name: "direct", config: { description: "declared" } },
    ]);
  });
});

describe("callableNames — prototype chain", () => {
  it("collects @callable methods up the chain to Agent, excluding plain methods", () => {
    class BaseAgent extends Agent<Record<string, never>> {
      static agentName = "chain";
      model = "test/chain-model";
      initialState = {};

      @callable()
      baseMethod() {
        return "base";
      }

      plainHelper() {
        return "nope";
      }
    }
    class MidAgent extends BaseAgent {
      @callable()
      midMethod() {
        return "mid";
      }
    }
    class LeafAgent extends MidAgent {
      @callable()
      leafMethod() {
        return "leaf";
      }
    }

    const Chain = compileAgentClass(LeafAgent);
    expect(Chain.spec.callableMethods).toEqual(["leafMethod", "midMethod", "baseMethod"]);
  });
});

describe("callable() — methods only", () => {
  it("legacy three-argument protocol: rejects a non-function value, naming the key", () => {
    const decorate = callable();
    expect(() => decorate({}, "count", { value: 0 })).toThrow(TypeError);
    expect(() => decorate({}, "count", { value: 0 })).toThrow(
      "callable() can only decorate methods (count)"
    );
  });

  it("stage-3 protocol: rejects a non-function target", () => {
    const decorate = callable();
    expect(() =>
      decorate({} as never, { kind: "field", name: "count" } as never)
    ).toThrow(/^callable\(\) can only decorate methods$/);
  });
});
