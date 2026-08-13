/**
 * `agent()` — the sealed authoring factory (cloudflare/agents shape).
 *
 * The claims under test:
 *
 *  1. RECORD EQUIVALENCE. `agent()` lowers to the exact `agentComponent`
 *     record: same spec fields, and byte-identical emitted artifacts (flue
 *     child profile, Think target) for the same logical spec. Discovery,
 *     collectPhases, the emitters, and the SimHost consume it with ZERO
 *     contract changes.
 *
 *  2. THE MODEL IS SEALED. It is authored once inside the factory, reaches
 *     every emitted definition (flue `model:` line, Think `getModel()`), and
 *     NEVER appears in any composition-site prop or serializable child config.
 *
 *  3. CAPABILITIES ARE THE SAME VOCABULARY. The concise `onX: "result"`
 *     spelling normalizes to the `{ kind }` form and compiles to identical
 *     binding metadata (result and method alike).
 *
 *  4. ONE FACTORY, BOTH SHAPES. A supervising agent (durable state + children,
 *     no model definition) is the same call with `model` omitted and a render
 *     that returns composition JSX.
 *
 *  5. `ctx.define` MERGES OVER SEALED DEFAULTS. Sealed model/displayName are
 *     the defaults; an explicit field overrides and is written back onto the
 *     spec at first resolution; static fields may not change between renders;
 *     defining with no model anywhere is a loud error.
 *
 *  6. THE MIGRATED CHESS SEAT HAS NO SPRINKLES: its child config is exactly
 *     `{ kind, turn }` — no side, no model, no identity keys.
 */

import { describe, expect, it } from "bun:test";

import { agent, agentComponent, type AnyAgentSpec } from "../src/agent-component.tsx";
import { result } from "../src/agent-class.tsx";
import { resolveAgentSpecDefinition } from "../src/agent-definition.tsx";
import { evaluateComponent, evaluateTree } from "../src/compile/evaluate.ts";
import { collectInfra, collectPrompt } from "../src/tree.ts";
import { createStore } from "../src/store.ts";
import { discoverAgents } from "../src/compile/graph.ts";
import { emitFlueChild } from "../src/compile/emit-flue.ts";
import { emitThink } from "../src/compile/emit-think.ts";
import { renderPrompt } from "../src/prompt.ts";
import { SimHost, type World } from "../src/sim-host.ts";
import { GoalProvider } from "../examples/goal/goal-provider.tsx";
import { OpenAISeat } from "../examples/chess-goal/players.tsx";
import {
  CHESS_GOAL_TABLE,
  declareChessGoal,
  initialChessGoalState,
  type ChessGoalState,
} from "../examples/chess-goal/match.tsx";

// ---------------------------------------------------------------------------
// One logical agent, authored twice: sealed factory vs. low-level record.

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

const SealedCourier = agent<CourierProps, CourierState>({
  name: "courier",
  model: "sim/courier-model",
  state: { trips: 0 },
  description: "Delivers one parcel.",
  displayName: "Courier",
  props: { parcel: "sample", onDelivered: () => {} },
  capabilities: { onDelivered: "result" },
  render: ({ props, state }) => courierPrompt(props.parcel, state.trips),
});

const LegacyCourier = agentComponent<CourierProps, CourierState>({
  agentName: "courier",
  initialState: { trips: 0 },
  model: "sim/courier-model",
  description: "Delivers one parcel.",
  displayName: "Courier",
  sampleProps: { parcel: "sample", onDelivered: () => {} },
  capabilities: { onDelivered: { kind: "result" } },
  impl: ({ parcel, store }) => courierPrompt(parcel, store.get().trips),
});

/** Function-valued members compare by identity; strip them so the comparison
 *  is about the DATA record both authoring paths produce. */
const dataRecord = (spec: AnyAgentSpec) => {
  const { impl: _impl, sampleProps: _sampleProps, ...rest } = spec;
  return rest;
};

const flueOf = (spec: AnyAgentSpec) =>
  emitFlueChild({ spec, exportName: "Courier", importPath: "./courier.tsx" });

const thinkOf = (Courier: typeof SealedCourier) => {
  const Root = agentComponent<{}, { seen: number }>({
    agentName: "courier-root",
    initialState: { seen: 0 },
    model: "sim/root-model",
    sampleProps: {},
    impl: () => (
      <>
        <Courier name="courier:1" parcel="p-1" onDelivered={result(() => {})} />
        <prompt>
          <sys p={10}>Courier root.</sys>
        </prompt>
      </>
    ),
  });
  const graph = discoverAgents(
    { spec: Root.spec, exportName: "CourierRoot", importPath: "../root.tsx" },
    [{ spec: Courier.spec, exportName: "Courier", importPath: "../courier.tsx" }],
  );
  const rootNode = graph[0]!;
  return emitThink(
    { spec: rootNode.spec, componentName: "CourierRoot", componentImport: "../root.tsx" },
    graph.slice(1).map((child) => ({
      spec: child.spec,
      exportName: child.exportName,
      importPath: child.importPath,
      sampleProps: child.samples?.[0]?.props,
      analysis: child.analysis,
    })),
    rootNode.analysis,
    { runtimeImport: "./runtime" },
  );
};

describe("agent() — record equivalence with agentComponent", () => {
  it("lowers to the same spec record (identity, state, model, metadata, normalized capabilities)", () => {
    expect(dataRecord(SealedCourier.spec)).toEqual(dataRecord(LegacyCourier.spec));
    // The normalized {kind} form, exactly what agentComponent declares.
    expect(SealedCourier.spec.capabilities).toEqual({ onDelivered: { kind: "result" } });
    expect(SealedCourier.spec.agentName).toBe("courier");
    expect(SealedCourier.spec.initialState).toEqual({ trips: 0 });
  });

  it("emits a byte-identical flue child profile", () => {
    expect(flueOf(SealedCourier.spec)).toBe(flueOf(LegacyCourier.spec));
  });

  it("emits a byte-identical Think target through discovery", () => {
    const sealed = thinkOf(SealedCourier);
    const legacy = thinkOf(LegacyCourier as unknown as typeof SealedCourier);
    expect(sealed.agents).toBe(legacy.agents);
    expect(sealed.wrangler).toBe(legacy.wrangler);
  });

  it("routes a granted result through the SimHost exactly like any boundary", () => {
    const received: string[] = [];
    const desired = evaluateTree(
      <SealedCourier
        name="courier:sim"
        parcel="p-9"
        onDelivered={result((receipt: string) => received.push(receipt))}
      />,
    ).flatMap((root) => collectInfra(root));

    const world: World = {
      statusAt: () => 200,
      subagentLatency: 1,
      subagentResult: () => "DELIVERED(p-9)",
    };
    const host = new SimHost(world);
    host.reconcile(desired);
    host.tick((fn) => fn());
    expect(received).toEqual(["DELIVERED(p-9)"]);
  });
});

describe("agent() — the model is sealed, never sprinkled", () => {
  it("reaches the resolved definition and the emitted artifacts", () => {
    expect(resolveAgentSpecDefinition(SealedCourier.spec).model).toBe("sim/courier-model");
    expect(flueOf(SealedCourier.spec)).toContain('model: "sim/courier-model"');
    expect(thinkOf(SealedCourier).agents).toContain(
      'override getModel() { return Courier.spec.model ?? "sim/courier-model"; }',
    );
  });

  it("never appears in the composition-site record", () => {
    const record = evaluateTree(
      <SealedCourier name="courier:1" parcel="p-1" onDelivered={result(() => {})} />,
    )
      .flatMap((root) => collectInfra(root))
      .find((candidate) => candidate.kind === "subagent")!;

    expect(Object.keys(record.config).sort()).toEqual(["kind", "parcel"]);
    expect(JSON.stringify(record.config)).not.toContain("sim/courier-model");
    expect(JSON.stringify(record.config)).not.toContain("model");
    expect(record.bindings).toEqual({ onDelivered: { kind: "result" } });
  });
});

describe("agent() — capability vocabulary", () => {
  interface ScannerProps {
    docId: string;
    readDoc: () => string;
    onScanned: (text: string) => void;
  }

  const Scanner = agent<ScannerProps, { seen: number }>({
    name: "scanner",
    state: { seen: 0 },
    props: { docId: "sample", readDoc: () => "", onScanned: () => {} },
    capabilities: { readDoc: "method", onScanned: "result" },
    render: ({ props }) => (
      <prompt>
        <sys p={10}>Scan {props.docId}.</sys>
      </prompt>
    ),
  });

  it("compiles method and result grants to the same binding metadata as agentComponent", () => {
    const record = evaluateTree(
      <Scanner name="scan:1" docId="d-1" readDoc={() => "text"} onScanned={() => {}} />,
    )
      .flatMap((root) => collectInfra(root))
      .find((candidate) => candidate.kind === "subagent")!;

    expect(record.bindings).toEqual({
      readDoc: { kind: "method" },
      onScanned: { kind: "result" },
    });
    // Serializable input only — the granted closures ride host-side.
    expect(record.config).toEqual({ kind: "scanner", docId: "d-1" });
    expect(Object.keys(record.handlers ?? {}).sort()).toEqual(["onScanned", "readDoc"]);
  });
});

describe("agent() — the supervisor shape (no model, composition render)", () => {
  const Fleet = agent<{}, { dispatched: number }>({
    name: "courier-fleet",
    state: { dispatched: 0 },
    description: "Supervises couriers.",
    props: {},
    render: ({ state }) => (
      <>
        <SealedCourier
          name="courier:a"
          parcel={`parcel-${state.dispatched}`}
          onDelivered={result(() => {})}
        />
        <prompt>
          <sys p={10}>Fleet root.</sys>
        </prompt>
      </>
    ),
  });

  it("carries no model and still discovers its children transitively", () => {
    expect(Fleet.spec.model).toBeUndefined();
    const graph = discoverAgents(
      { spec: Fleet.spec, exportName: "Fleet", importPath: "../fleet.tsx" },
      [{ spec: SealedCourier.spec, exportName: "Courier", importPath: "../courier.tsx" }],
    );
    expect(graph.map((node) => node.spec.agentName)).toEqual(["courier-fleet", "courier"]);
    expect(graph[0]!.directChildren).toEqual(["courier"]);
  });

  it("renders the child boundary from durable state", () => {
    const roots = evaluateComponent(Fleet.spec.impl, {
      store: createStore({ dispatched: 3 }),
      emit: () => {},
    } as never);
    const record = roots
      .flatMap((root) => collectInfra(root))
      .find((candidate) => candidate.kind === "subagent")!;
    expect(record.config).toEqual({ kind: "courier", parcel: "parcel-3" });
  });
});

describe("agent() — ctx.define merges over the sealed defaults", () => {
  it("flows sealed model/displayName into an explicit definition and writes resolved fields back", () => {
    const Scribe = agent<{ topic: string }, Record<string, unknown>>({
      name: "scribe",
      model: "sim/scribe-default",
      displayName: "Scribe",
      state: {},
      props: { topic: "sample" },
      render: ({ props, define }) =>
        define({
          description: "Writes one note.",
          prompt: (
            <prompt>
              <sys p={10}>Write about {props.topic}.</sys>
            </prompt>
          ),
        }),
    });

    const roots = evaluateComponent(Scribe.spec.impl, {
      topic: "t-1",
      store: createStore({}),
      emit: () => {},
    } as never);
    const text = renderPrompt(collectPrompt(roots), 200)
      .included.map((block) => block.text)
      .join(" ");
    expect(text).toContain("Write about t-1.");

    // Sealed default + define-supplied description, one consistent record.
    expect(Scribe.spec.model).toBe("sim/scribe-default");
    expect(Scribe.spec.displayName).toBe("Scribe");
    expect(Scribe.spec.description).toBe("Writes one note.");
  });

  it("lets an explicit define model override the sealed default", () => {
    const Overrider = agent<{}, Record<string, unknown>>({
      name: "overrider",
      model: "sim/default-model",
      state: {},
      props: {},
      render: ({ define }) => define({ model: "sim/override-model", prompt: "override" }),
    });

    expect(Overrider.spec.model).toBe("sim/default-model"); // sealed, pre-render
    evaluateComponent(Overrider.spec.impl, { store: createStore({}), emit: () => {} } as never);
    expect(Overrider.spec.model).toBe("sim/override-model"); // explicit define wins
  });

  it("refuses a static definition field that changes between renders", () => {
    const Moody = agent<{}, { alt: boolean }>({
      name: "moody",
      state: { alt: false },
      props: {},
      render: ({ state, define }) =>
        define({ model: state.alt ? "sim/alt" : "sim/base", prompt: "steady" }),
    });

    evaluateComponent(Moody.spec.impl, { store: createStore({ alt: false }), emit: () => {} } as never);
    expect(() =>
      evaluateComponent(Moody.spec.impl, { store: createStore({ alt: true }), emit: () => {} } as never),
    ).toThrow('[agent-jsx] agent "moody": definition field "model" changed between renders');
  });

  it("throws loudly when define has no model anywhere", () => {
    const Nameless = agent<{}, Record<string, unknown>>({
      name: "nameless",
      state: {},
      props: {},
      render: ({ define }) => define({ prompt: "hi" }),
    });
    expect(() =>
      evaluateComponent(Nameless.spec.impl, { store: createStore({}), emit: () => {} } as never),
    ).toThrow('[agent-jsx] agent "nameless": definition.model must contain a non-empty model id');
  });
});

describe("agent() — the migrated chess seat carries no sprinkles", () => {
  it("mounts with exactly { kind, turn } and its one result grant", () => {
    const store = createStore<ChessGoalState>(initialChessGoalState);
    const seat = evaluateTree(
      <GoalProvider table={CHESS_GOAL_TABLE} store={store}>
        {declareChessGoal(store)}
      </GoalProvider>,
    )
      .flatMap((root) => collectInfra(root))
      .find((record) => record.kind === "subagent")!;

    expect(Object.keys(seat.config).sort()).toEqual(["kind", "turn"]);
    expect(JSON.stringify(seat.config)).not.toContain("model");
    expect(JSON.stringify(seat.config)).not.toContain("gpt-5-mini");
    expect(seat.bindings).toEqual({ onTurn: { kind: "result" } });

    // The identity/model live in the sealed record instead.
    expect(OpenAISeat.spec.agentName).toBe("openai-chess-player");
    expect(OpenAISeat.spec.model).toBe("openrouter/openai/gpt-5-mini");
    expect(resolveAgentSpecDefinition(OpenAISeat.spec).model).toBe(
      "openrouter/openai/gpt-5-mini",
    );
  });
});
