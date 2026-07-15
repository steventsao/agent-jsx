import {
  Agent,
  callable,
  compileAgentClass,
  composeAgent,
  result,
} from "../src/agent-class.tsx";

class Parent extends Agent<{ count: number }> {
  static agentName = "typed-parent";
  model = "test/parent";
  initialState = { count: 0 };

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
  model = "test/child";
  initialState = {};
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
