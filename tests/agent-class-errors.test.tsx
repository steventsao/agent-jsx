/**
 * Class-authoring error paths and the pieces of src/agent-class.tsx +
 * src/callable.ts the happy-path suite never exercises:
 *
 *   - compileAgentClass requires a static agentName; definition evaluation
 *     requires a non-empty model, loudly;
 *   - invokeCallable refuses methods not decorated with @callable();
 *   - composeAgent requires a function child;
 *   - before __bind, state/setState work against DETACHED state (initialState
 *     fallback, then an accumulated private copy); binding a store shadows it;
 *   - rendered AI SDK tool objects retain their metadata, invalid scalar tools
 *     fail loudly, and declarative tool JSX passes through untouched;
 *   - deleted class members fail at the migration seam instead of leaking as
 *     undefined render-prop bindings;
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
import { z } from "zod";

interface CounterState extends Record<string, unknown> {
  count: number;
}

class CounterAgent extends Agent<CounterState, { step: number }> {
  static agentName = "counter";
  initialState: CounterState = { count: 0 };

  render() {
    return this.define({ model: "test/counter-model" });
  }

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
      initialState: CounterState = { count: 0 };
      render() {
        return this.define({ model: "test/model" });
      }
    }
    expect(() => compileAgentClass(AnonymousAgent as never)).toThrow(
      "[agent-jsx] Agent class needs static agentName"
    );
  });

  it("throws when render declares an empty model", () => {
    class ModellessAgent extends Agent<CounterState> {
      static agentName = "modelless";
      initialState: CounterState = { count: 0 };
      render() {
        return this.define({ model: "" });
      }
    }
    const Modelless = compileAgentClass(ModellessAgent);
    expect(() =>
      Modelless.spec.resolveDefinition!({}, createStore({ count: 0 }))
    ).toThrow(
      '[agent-jsx] agent "modelless": definition.model must contain a non-empty model id'
    );
  });

  it("accepts equivalent inline Zod contracts while rejecting a changed contract", () => {
    class InlineSchemaAgent extends Agent<
      { numeric: boolean },
      { query: unknown }
    > {
      static agentName = "inline-schema";
      initialState = { numeric: false };

      render() {
        return this.define({
          model: "test/model",
          inputSchema: z.object({
            query: this.state.numeric ? z.number() : z.string(),
          }),
        });
      }
    }

    const InlineSchema = compileAgentClass(InlineSchemaAgent);
    expect(() =>
      InlineSchema.spec.resolveDefinition!(
        { query: "first" },
        createStore<{ numeric: boolean }>({ numeric: false }),
      )
    ).not.toThrow();
    // render() constructs a fresh Zod object on every declaration evaluation.
    expect(() =>
      InlineSchema.spec.resolveDefinition!(
        { query: "second" },
        createStore<{ numeric: boolean }>({ numeric: false }),
      )
    ).not.toThrow();
    expect(() =>
      InlineSchema.spec.resolveDefinition!(
        { query: 3 },
        createStore<{ numeric: boolean }>({ numeric: true }),
      )
    ).toThrow(
      '[agent-jsx] agent "inline-schema": static definition field "inputSchema" changed between renders',
    );
  });

  it("uses SkillSource id and fingerprint for equivalent inline declarations", () => {
    class InlineSkillAgent extends Agent<{ revision: number }> {
      static agentName = "inline-skill";
      initialState = { revision: 1 };

      render() {
        const revision = this.state.revision;
        return this.define({
          model: "test/model",
          skills: [{
            id: "review",
            fingerprint: `review-v${revision}`,
            async list() { return []; },
            async load() { return null; },
          }],
        });
      }
    }

    const InlineSkill = compileAgentClass(InlineSkillAgent);
    expect(() => InlineSkill.spec.resolveDefinition!(
      {},
      createStore({ revision: 1 }),
    )).not.toThrow();
    expect(() => InlineSkill.spec.resolveDefinition!(
      {},
      createStore({ revision: 1 }),
    )).not.toThrow();
    expect(() => InlineSkill.spec.resolveDefinition!(
      {},
      createStore({ revision: 2 }),
    )).toThrow(
      '[agent-jsx] agent "inline-skill": static definition field "skills" changed between renders',
    );
  });

  it("rejects deleted class definition members with one migration diagnostic", () => {
    class PartiallyMigratedAgent extends Agent<Record<string, never>> {
      static agentName = "partial-migration";
      initialState = {};
      model = "legacy/model";
      description = "legacy description";
      displayName = "Legacy display name";

      getPrompt() {
        return "legacy prompt";
      }

      getTools() {
        return {};
      }

      getSkills() {
        return [];
      }

      render() {
        return this.define({ model: "test/model" });
      }
    }

    expect(() => compileAgentClass(PartiallyMigratedAgent)).toThrow(
      '[agent-jsx] Agent class "partial-migration" still declares removed members: model, description, displayName, getPrompt, getTools, getSkills. Move model, metadata, prompt, tools, skills, and MCP servers into render() { return this.define({...}) }.',
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

describe("rendered tools — object map edge cases", () => {
  class ToolboxAgent extends Agent<Record<string, never>> {
    static agentName = "toolbox";
    initialState = {};

    render() {
      return this.define({
        model: "test/toolbox-model",
        tools: {
          runner: { description: "run alias", run: () => "ran" },
          executor: { description: "execute alias", execute: () => "executed" },
          bare: { execute: () => "no description" },
          noCallable: { description: "missing execute/run" },
        },
      });
    }
  }

  it("preserves object tool definitions without flattening their metadata", () => {
    const Toolbox = compileAgentClass(ToolboxAgent);
    const definition = Toolbox.spec.resolveDefinition!({}, createStore({}));
    expect(Object.keys(definition.tools)).toEqual([
      "runner",
      "executor",
      "bare",
      "noCallable",
    ]);
    expect((definition.tools.runner as { run(): string }).run()).toBe("ran");
    expect((definition.tools.executor as { execute(): string }).execute()).toBe("executed");
  });

  it("rejects scalar tool entries instead of silently dropping them", () => {
    class InvalidToolboxAgent extends Agent<Record<string, never>> {
      static agentName = "invalid-toolbox";
      initialState = {};
      render() {
        return this.define({
          model: "test/model",
          tools: { scalar: 42 as never },
        });
      }
    }
    const InvalidToolbox = compileAgentClass(InvalidToolboxAgent);
    expect(() => InvalidToolbox.spec.resolveDefinition!({}, createStore({}))).toThrow(
      '[agent-jsx] agent "invalid-toolbox": definition.tools.scalar must be an AI SDK tool definition',
    );
  });

  it("passes declarative <tool> JSX through untouched", () => {
    class JsxToolsAgent extends Agent<Record<string, never>> {
      static agentName = "jsx-tools";
      initialState = {};

      render() {
        return this.define({
          model: "test/jsx-tools-model",
          tools: <tool name="direct" description="declared" run={() => "ok"} />,
        });
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
      initialState = {};

      render() {
        return this.define({ model: "test/chain-model" });
      }

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
