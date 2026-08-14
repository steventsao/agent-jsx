import { describe, expect, it } from "bun:test";

import {
  agentComponent,
  compileAgent,
  defineAgentProfile,
  type AgentRenderProps,
  type AnyAgentSpec,
} from "../src/agent-component.tsx";
import { result } from "../src/agent-class.tsx";
import { evaluateComponent, evaluateTree } from "../src/compile/evaluate.ts";
import { collectInfra } from "../src/tree.ts";
import { createStore } from "../src/store.ts";
import { discoverAgents } from "../src/compile/graph.ts";
import { OpenAISeat } from "../examples/chess-goal/players.tsx";
import { GoalProvider } from "../examples/goal/goal-provider.tsx";
import {
  CHESS_GOAL_TABLE,
  declareChessGoal,
  initialChessGoalState,
  type ChessGoalState,
} from "../examples/chess-goal/match.tsx";

interface CourierProps {
  parcel: string;
  onDelivered: (receipt: string) => void;
}

interface CourierState extends Record<string, unknown> {
  trips: number;
}

const courierPrompt = (parcel: string, trips: number) => (
  <prompt>
    <sys p={10}>You deliver parcel {parcel}.</sys>
    <msg p={7}>{trips} trips so far.</msg>
  </prompt>
);

function Courier({ parcel, store }: AgentRenderProps<CourierProps, CourierState>) {
  return courierPrompt(parcel, store.get().trips);
}

const courierProfile = defineAgentProfile<CourierProps, CourierState>({
  name: "courier",
  model: "sim/courier-model",
  description: "Delivers one parcel.",
  displayName: "Courier",
  initialState: { trips: 0 },
  sampleProps: { parcel: "sample", onDelivered: () => {} },
  capabilities: { onDelivered: "result" },
});

const CompiledCourier = compileAgent(Courier, courierProfile);

const LegacyCourier = agentComponent<CourierProps, CourierState>({
  agentName: "courier",
  model: "sim/courier-model",
  description: "Delivers one parcel.",
  displayName: "Courier",
  initialState: { trips: 0 },
  sampleProps: { parcel: "sample", onDelivered: () => {} },
  capabilities: { onDelivered: { kind: "result" } },
  impl: Courier,
});

const dataRecord = (spec: AnyAgentSpec) => {
  const { impl: _impl, sampleProps: _sampleProps, ...data } = spec;
  return data;
};

describe("PascalCase function agents", () => {
  it("lowers a direct JSX function to the existing boundary record", () => {
    expect(CompiledCourier.spec.impl).toBe(Courier);
    expect(dataRecord(CompiledCourier.spec)).toEqual(dataRecord(LegacyCourier.spec));
    expect(CompiledCourier.spec.capabilities).toEqual({
      onDelivered: { kind: "result" },
    });

    const record = evaluateTree(
      <CompiledCourier
        name="courier:1"
        parcel="p-1"
        onDelivered={result(() => {})}
      />,
    )
      .flatMap((root) => collectInfra(root))
      .find((candidate) => candidate.kind === "subagent")!;

    expect(record.config).toEqual({ kind: "courier", parcel: "p-1" });
    expect(record.bindings).toEqual({ onDelivered: { kind: "result" } });
    expect(JSON.stringify(record.config)).not.toContain("model");
  });

  it("does not execute a component while its companion module loads", () => {
    let renders = 0;
    function Required({ input }: AgentRenderProps<{ input: { query: string } }, {}>) {
      renders += 1;
      return <prompt>{input.query.toUpperCase()}</prompt>;
    }

    const RequiredAgent = compileAgent(
      Required,
      defineAgentProfile<{ input: { query: string } }, {}>({
        name: "required",
        model: "sim/required",
        initialState: {},
      }),
    );
    expect(renders).toBe(0);

    evaluateComponent(RequiredAgent.spec.impl, {
      input: { query: "ready" },
      store: createStore({}),
    });
    expect(renders).toBe(1);
  });

  it("uses the same function + profile shape for a model-free supervisor", () => {
    function Fleet({ store }: AgentRenderProps<{}, { dispatched: number }>) {
      return (
        <CompiledCourier
          name="courier:a"
          parcel={`parcel-${store.get().dispatched}`}
          onDelivered={result(() => {})}
        />
      );
    }

    const FleetAgent = compileAgent(
      Fleet,
      defineAgentProfile<{}, { dispatched: number }>({
        name: "courier-fleet",
        initialState: { dispatched: 0 },
        sampleProps: {},
      }),
    );

    expect(FleetAgent.spec.model).toBeUndefined();
    const graph = discoverAgents(
      { spec: FleetAgent.spec, exportName: "Fleet", importPath: "../fleet.tsx" },
      [{ spec: CompiledCourier.spec, exportName: "Courier", importPath: "../courier.tsx" }],
    );
    expect(graph.map((node) => node.spec.agentName)).toEqual(["courier-fleet", "courier"]);
  });

  it("rejects an empty durable profile name", () => {
    expect(() =>
      defineAgentProfile<{}, {}>({
        name: "   ",
        model: "sim/blank",
        initialState: {},
      }),
    ).toThrow("profile needs a non-empty durable `name`");

    expect(() =>
      compileAgent(
        () => null,
        { name: "", model: "sim/blank", initialState: {} },
      ),
    ).toThrow("profile needs a non-empty durable `name`");
  });

  it("keeps the migrated chess seat free of model and identity sprinkles", () => {
    const store = createStore<ChessGoalState>(initialChessGoalState);
    const seat = evaluateTree(
      <GoalProvider table={CHESS_GOAL_TABLE} store={store}>
        {declareChessGoal(store)}
      </GoalProvider>,
    )
      .flatMap((root) => collectInfra(root))
      .find((record) => record.kind === "subagent")!;

    expect(Object.keys(seat.config).sort()).toEqual(["kind", "turn"]);
    expect(seat.bindings).toEqual({ onTurn: { kind: "result" } });
    expect(OpenAISeat.spec.agentName).toBe("openai-chess-player");
    expect(OpenAISeat.spec.model).toBe("openrouter/openai/gpt-5-mini");
  });
});
