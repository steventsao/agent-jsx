import {
  Agent,
  callable,
  compileAgentClass,
  composeAgent,
  result,
  type AgentBindings,
} from "../src/agent-class.tsx";

class Parent extends Agent<{ count: number }> {
  static agentName = "typed-parent";
  initialState = { count: 0 };

  render() {
    return this.define({ model: "test/parent" });
  }

  get next() {
    return this.state.count + 1;
  }

  @callable()
  accept(value: number): void {
    this.setState({ count: value });
  }
}

interface ChildProps {
  value: number;
  onValue: (value: number) => void;
}

class Child extends Agent<Record<string, never>, ChildProps> {
  static agentName = "typed-child";
  initialState = {};

  render() {
    return this.define({ model: "test/child" });
  }
}

const ParentComponent = compileAgentClass(Parent);
const ChildComponent = compileAgentClass(Child);

composeAgent(
  <ParentComponent name="parent">
    {({ next, accept }) => (
      <ChildComponent name="child" value={next} onValue={result(accept)} />
    )}
  </ParentComponent>,
);

class PartiallyMigrated extends Agent<Record<string, never>> {
  static agentName = "typed-partial-migration";
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

  get label() {
    return "visible binding";
  }

  render() {
    return this.define({ model: "test/model" });
  }
}

declare const migratedBindings: AgentBindings<typeof PartiallyMigrated>;
migratedBindings.label satisfies string;
// @ts-expect-error deleted model declarations are not render-prop bindings.
migratedBindings.model;
// @ts-expect-error deleted description declarations are not render-prop bindings.
migratedBindings.description;
// @ts-expect-error deleted displayName declarations are not render-prop bindings.
migratedBindings.displayName;
// @ts-expect-error deleted getPrompt declarations are not render-prop bindings.
migratedBindings.getPrompt;
// @ts-expect-error deleted getTools declarations are not render-prop bindings.
migratedBindings.getTools;
// @ts-expect-error deleted getSkills declarations are not render-prop bindings.
migratedBindings.getSkills;

composeAgent(
  <ParentComponent name="parent">
    {({ next, accept }) => (
      <ChildComponent
        name="child"
        // @ts-expect-error the getter remains a number through the render prop.
        value={String(next)}
        onValue={result(accept)}
      />
    )}
  </ParentComponent>,
);

composeAgent(
  <ParentComponent name="parent">
    {({ accept }) => (
      <ChildComponent
        name="child"
        value={1}
        // @ts-expect-error callable argument types survive the binding wrapper.
        onValue={result((value: string) => accept(Number(value)))}
      />
    )}
  </ParentComponent>,
);
