/**
 * Chess rewritten on the goal/phase supervision layer.
 *
 * The claim under test is the TWO-REDUCER SPLIT:
 *
 *   domain reducer (chess.js via reduceChessTurn, reused verbatim from
 *   examples/chess/board.tsx)  → decides WHETHER an outcome happened
 *   goal reducer (src/goal.ts) → decides WHAT IT MEANS (who acts next)
 *
 * and the properties that fall out of it:
 *
 *  1. ALTERNATION IS PHASE-DRIVEN. The white/black seats are children of
 *     `<phase name="white">` / `<phase name="black">`; only the active phase's
 *     seat is mounted, and every hand-over is an attributed goal transition
 *     (`white[seat:white] moved ▶ black`), not an if/else in the board.
 *
 *  2. AN ILLEGAL MOVE MOVES NOTHING. The domain refuses it (lastError), no
 *     outcome is dispatched, the SAME phase stays mounted, and the seat's next
 *     turn context carries lastError as the re-prompt.
 *
 *  3. A LATE/OUT-OF-TURN CALLBACK IS REFUSED AS STALE. The grant was minted for
 *     its phase; once the goal has moved on, replaying it is provably stale —
 *     attribution, not trust, protects the machine.
 *
 *  4. THE MATCH ENDS BY EDGE, NOT BY EXCEPTION: checkmate/draw/ply-cap all
 *     dispatch `ended`, and `over` is an ordinary phase with no children.
 *
 *  5. DETERMINISTIC REPLAY: the same scripted match folds to byte-identical
 *     final state, twice.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import { collectInfra } from "../src/tree.ts";
import { evaluateComponent, evaluateTree } from "../src/compile/evaluate.ts";
import { discoverAgents, type AgentModule } from "../src/compile/graph.ts";
import { emitThink } from "../src/compile/emit-think.ts";
import { emitRuntimeFiles } from "../src/compile/runtime-files.ts";
import { runReactiveStep, runReactiveWorkflow } from "../src/workflow-executor.ts";
import { turnFor } from "../examples/chess/board.tsx";
import { GeminiSeat, OpenAISeat } from "../examples/chess-goal/players.tsx";
import { GoalProvider, type GoalDispatch, type GoalTransition } from "../examples/goal/goal-provider.tsx";
import { analyzeGoal } from "../examples/goal/goal-dev.ts";
import {
  CHESS_GOAL_TABLE,
  ChessGoalMatch,
  declareChessGoal,
  goalStateAfterMoves,
  initialChessGoalState,
  recordChessTransition,
  seatTurnHandler,
  type ChessGoalState,
} from "../examples/chess-goal/match.tsx";

/** Fool's mate: the shortest scripted route to `ended` via checkmate. */
const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"];

const rootModule = (states: ChessGoalState[]): AgentModule => ({
  spec: ChessGoalMatch.spec,
  exportName: "ChessGoalMatch",
  importPath: "../match.tsx",
  samples: states.map((state) => ({ state })),
});

const playerModules: AgentModule[] = [
  { spec: OpenAISeat.spec, exportName: "OpenAISeat", importPath: "../players.tsx" },
  { spec: GeminiSeat.spec, exportName: "GeminiSeat", importPath: "../players.tsx" },
];

describe("chess goal table", () => {
  it("folds the seats' phases into the flat transition table", () => {
    expect(CHESS_GOAL_TABLE).toEqual({
      initial: "white",
      edges: {
        white: { moved: "black", ended: "over" },
        black: { moved: "white", ended: "over" },
        over: {},
      },
    });
  });

  it("passes the static goal checks with `over` as the met phase", () => {
    expect(analyzeGoal(CHESS_GOAL_TABLE, { doneState: "over" })).toEqual([]);
  });

  it("seeds the initial durable state at the entry phase", () => {
    expect(initialChessGoalState.goal).toEqual({ phase: "white" });
    expect(initialChessGoalState.log).toEqual([]);
  });
});

describe("chess goal composition — only the active phase's seat mounts", () => {
  it("mounts white's seat with its own input plus the one result grant", () => {
    const store = createStore<ChessGoalState>(initialChessGoalState);
    const records = evaluateTree(
      <GoalProvider table={CHESS_GOAL_TABLE} store={store}>
        {declareChessGoal(store)}
      </GoalProvider>,
    ).flatMap((root) => collectInfra(root));
    const subagents = records.filter((record) => record.kind === "subagent");

    expect(subagents).toHaveLength(1);
    const seat = subagents[0]!;
    expect(seat.name).toBe("white:0");
    expect(seat.config.kind).toBe("openai-chess-player");
    // Serializable seat input only: no phase names, no edge maps, no vocabulary
    // — and no model/identity sprinkles either; the seat is a sealed
    // function+profile capsule, so the side lives in the turn and the model
    // lives in the record.
    expect(Object.keys(seat.config).sort()).toEqual(["kind", "turn"]);
    expect(seat.config.turn).toMatchObject({ side: "white", ply: 0, lastError: null });
    expect(seat.bindings).toEqual({ onTurn: { kind: "result" } });
  });

  it("mounts black's seat once the goal is at the black phase", () => {
    const afterE4 = goalStateAfterMoves(["e2e4"]);
    expect(afterE4.goal).toEqual({ phase: "black" });

    const store = createStore<ChessGoalState>(afterE4);
    const [seat, ...rest] = evaluateTree(
      <GoalProvider table={CHESS_GOAL_TABLE} store={store}>
        {declareChessGoal(store)}
      </GoalProvider>,
    )
      .flatMap((root) => collectInfra(root))
      .filter((record) => record.kind === "subagent");

    expect(rest).toEqual([]);
    expect(seat?.name).toBe("black:1");
    expect(seat?.config.kind).toBe("gemini-chess-player");
  });

  it("keeps the same shape through the composed root (the worker's component)", () => {
    const roots = evaluateComponent(ChessGoalMatch.spec.impl, {
      store: createStore<ChessGoalState>(initialChessGoalState),
      emit: () => {},
    });
    const seat = roots
      .flatMap((root) => collectInfra(root))
      .find((record) => record.kind === "subagent");

    expect(seat?.name).toBe("white:0");
    expect(seat?.config.kind).toBe("openai-chess-player");
    expect(seat?.target).toBe(OpenAISeat);
  });

  it("mounts nothing once the goal is over", () => {
    const over = goalStateAfterMoves(FOOLS_MATE);
    expect(over.goal).toEqual({ phase: "over" });

    const roots = evaluateComponent(ChessGoalMatch.spec.impl, {
      store: createStore<ChessGoalState>(over),
      emit: () => {},
    });
    const subagents = roots
      .flatMap((root) => collectInfra(root))
      .filter((record) => record.kind === "subagent");
    expect(subagents).toEqual([]);
  });
});

describe("chess goal reactive step — the worker's /step path", () => {
  it("keeps the phase and records lastError when the model plays an illegal move", async () => {
    const first = await runReactiveStep({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: initialChessGoalState,
      delegate: () => ({ move: "e2e5", note: "illegal" }),
    });

    expect(first.descriptor).toMatchObject({ stableId: "white:0", agent: "openai-chess-player" });
    expect(first.state.history).toEqual([]);
    expect(first.state.lastError).toContain("illegal move");
    // No dispatch happened: the goal never left white.
    expect(first.state.goal).toEqual({ phase: "white" });
    expect(first.state.log).toEqual([]);

    // The SAME seat is re-prompted, now with lastError in its turn context.
    const second = await runReactiveStep({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: first.state,
      delegate: (descriptor) => {
        expect(descriptor.stableId).toBe("white:0");
        expect((descriptor.input.turn as { lastError: string }).lastError).toContain("illegal move");
        return { move: "e2e4", note: "corrected" };
      },
    });

    expect(second.state.history.map((move) => move.uci)).toEqual(["e2e4"]);
    expect(second.state.lastError).toBeNull();
    expect(second.state.goal).toEqual({ phase: "black" });
    expect(second.state.log).toMatchObject([
      { outcome: "moved", source: { phase: "white", child: "seat:white" }, from: "white", to: "black", changed: true, ply: 1, san: "e4" },
    ]);
  });

  it("hands the turn to the other model through the phase edge", async () => {
    const afterE4 = goalStateAfterMoves(["e2e4"]);
    const step = await runReactiveStep({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: afterE4,
      delegate: (descriptor) => {
        expect(descriptor.agent).toBe("gemini-chess-player");
        expect(descriptor.target).toBe(GeminiSeat);
        return { move: "e7e5", note: "mirrors" };
      },
    });
    expect(step.state.goal).toEqual({ phase: "white" });
    expect(step.state.log).toMatchObject([
      { outcome: "moved", source: { phase: "black", child: "seat:black" }, to: "white", changed: true },
    ]);
  });
});

describe("chess goal reactive workflow — a full scripted match", () => {
  const playMatch = () =>
    runReactiveWorkflow({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: initialChessGoalState,
      delegate: (descriptor) => {
        const ply = Number(String(descriptor.stableId).split(":")[1]);
        expect(descriptor.target).toBe(ply % 2 === 0 ? OpenAISeat : GeminiSeat);
        return { move: FOOLS_MATE[ply]!, note: `scripted ${ply}`, thought: `plan ${ply}` };
      },
    });

  it("alternates seats phase by phase and reaches over via ended", async () => {
    const result = await playMatch();

    expect(result.delegated).toEqual(["white:0", "black:1", "white:2", "black:3"]);
    expect(result.state.history.map((move) => move.uci)).toEqual(FOOLS_MATE);
    expect(result.state.status).toBe("checkmate");
    expect(result.state.winner).toBe("black");
    expect(result.state.goal).toEqual({ phase: "over" });

    // The attributed transition log IS the alternation proof: every hand-over
    // names the phase and seat whose grant spent the outcome.
    expect(
      result.state.log.map(
        (entry) => `${entry.source.phase}[${entry.source.child}] ${entry.outcome} ▶ ${entry.to}`,
      ),
    ).toEqual([
      "white[seat:white] moved ▶ black",
      "black[seat:black] moved ▶ white",
      "white[seat:white] moved ▶ black",
      "black[seat:black] ended ▶ over",
    ]);
    // And the domain agrees with the goal at every step (lockstep invariant).
    expect(result.state.log.map((entry) => entry.san)).toEqual(["f3", "e5", "g4", "Qh4#"]);
    expect(result.state.log.every((entry) => entry.changed)).toBe(true);
  });

  it("replays deterministically — same script, byte-identical final state", async () => {
    const [first, second] = [await playMatch(), await playMatch()];
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state));
  });

  it("ends via the same `ended` edge at the ply cap", async () => {
    const script = ["e2e4", "e7e5", "g1f3", "b8c6"];
    const result = await runReactiveWorkflow({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: { ...initialChessGoalState, maxPlies: script.length },
      delegate: (descriptor) => ({
        move: script[Number(String(descriptor.stableId).split(":")[1])]!,
      }),
    });

    expect(result.state.status).toBe("max-plies");
    expect(result.state.goal).toEqual({ phase: "over" });
    expect(result.state.log.at(-1)).toMatchObject({
      outcome: "ended",
      source: { phase: "black", child: "seat:black" },
      to: "over",
      changed: true,
    });
  });
});

describe("chess goal under the live SimHost reconciler", () => {
  it("plays a scripted match: phases mount seats, transitions hand the board over", () => {
    const script: Record<string, string> = {
      "white:0": "f2f3",
      "black:1": "e7e5",
      "white:2": "g2g4",
      "black:3": "d8h4",
    };
    const host = new SimHost({
      statusAt: () => 200,
      subagentLatency: 1,
      subagentResult: (record) => ({ move: script[record.name]!, note: "scripted" }),
    });
    const store = createStore<ChessGoalState>(initialChessGoalState);
    const agent = mountAgent(<ChessGoalMatch.spec.impl store={store} />, host, { quiet: true });

    for (let t = 1; t <= 8; t += 1) agent.tick();

    // The op log IS the phase-driven alternation: each transition mounted the
    // next phase's seat and unmounted the old one (a reconcile pass records
    // creates before removes), in strict alternation to the end.
    expect(
      host.opLog
        .filter((op) => op.kind === "subagent")
        .map((op) => `${op.op} ${op.name}`),
    ).toEqual([
      "create white:0",
      "create black:1",
      "remove white:0",
      "create white:2",
      "remove black:1",
      "create black:3",
      "remove white:2",
      "remove black:3",
    ]);
    expect(store.get().status).toBe("checkmate");
    expect(store.get().winner).toBe("black");
    expect(store.get().goal).toEqual({ phase: "over" });
    expect(store.get().log.map((entry) => `${entry.source.phase} ${entry.outcome} ▶ ${entry.to}`)).toEqual([
      "white moved ▶ black",
      "black moved ▶ white",
      "white moved ▶ black",
      "black ended ▶ over",
    ]);
    expect([...host.liveRecords.values()].filter((r) => r.kind === "subagent")).toEqual([]);
    agent.unmount();
  });
});

describe("chess goal staleness — a late grant cannot corrupt the match", () => {
  /** Render the provider once against a live store, keeping the minted grants
   *  and the routed seat handler, exactly as a host would hold them. */
  const mountOnce = () => {
    const store = createStore<ChessGoalState>(initialChessGoalState);
    const grants = new Map<string, GoalDispatch>();
    const transitions: GoalTransition[] = [];
    const onTransition = (transition: GoalTransition) => {
      recordChessTransition(store)(transition);
      transitions.push(transition);
    };
    const seat = () =>
      evaluateTree(
        <GoalProvider table={CHESS_GOAL_TABLE} store={store} onTransition={onTransition}>
          {declareChessGoal(store, grants)}
        </GoalProvider>,
      )
        .flatMap((root) => collectInfra(root))
        .find((record) => record.kind === "subagent");
    return { store, grants, transitions, seat };
  };

  it("refuses a replayed raw grant from the previous side as stale", () => {
    const { store, grants, transitions, seat } = mountOnce();
    seat()!.handlers.onTurn!({ move: "e2e4", note: "opening" });
    expect(store.get().goal).toEqual({ phase: "black" });

    // The white grant — minted for the white phase — fires again, late.
    grants.get("white/seat:white")!("moved");

    expect(transitions.at(-1)).toMatchObject({
      outcome: "moved",
      source: { phase: "white", child: "seat:white" },
      from: "black",
      changed: false,
      ignored: "stale",
    });
    expect(store.get().goal).toEqual({ phase: "black" });
    expect(store.get().history).toHaveLength(1);
    // The refusal is part of the durable attributed log.
    expect(store.get().log.at(-1)).toMatchObject({ ignored: "stale", changed: false });
  });

  it("routes a late out-of-turn seat callback into the same stale refusal", () => {
    const { store, grants, transitions, seat } = mountOnce();
    seat()!.handlers.onTurn!({ move: "e2e4" });

    // The whole seat handler replays after the goal moved on: the DOMAIN
    // refuses to move (wrong side), and the dispatch is refused as stale.
    seatTurnHandler(store, "white", grants.get("white/seat:white")!)({ move: "d2d4" });

    expect(store.get().history).toHaveLength(1); // board untouched
    expect(store.get().goal).toEqual({ phase: "black" });
    expect(transitions.at(-1)).toMatchObject({ ignored: "stale", changed: false });
  });

  it("keeps goal and board in lockstep after every applied transition", () => {
    const { store, seat } = mountOnce();
    for (const move of FOOLS_MATE) {
      seat()!.handlers.onTurn!({ move });
      const state = store.get();
      const expected = turnFor(state)?.side ?? "over";
      expect(state.goal!.phase).toBe(expected);
    }
    expect(store.get().goal).toEqual({ phase: "over" });
    expect(seat()).toBeUndefined(); // over mounts no children
  });
});

describe("chess goal compile pipeline", () => {
  const graph = discoverAgents(
    rootModule([initialChessGoalState, goalStateAfterMoves(["e2e4"])]),
    playerModules,
  );

  it("discovers both seat agents behind the phase gating", () => {
    expect(graph.map((node) => node.spec.agentName)).toEqual([
      "chess-goal-match",
      "openai-chess-player",
      "gemini-chess-player",
    ]);
    expect(graph[0]?.directChildren).toEqual(["openai-chess-player", "gemini-chess-player"]);
  });

  it("emits the Think target for the goal-shaped root without choking", () => {
    const root = graph[0]!;
    const think = emitThink(
      {
        spec: root.spec,
        componentName: root.exportName,
        componentImport: root.importPath,
      },
      graph.slice(1).map((child) => ({
        spec: child.spec,
        exportName: child.exportName,
        importPath: child.importPath,
        sampleProps: child.samples?.[0]?.props,
        analysis: child.analysis,
      })),
      root.analysis,
      { runtimeImport: "./runtime" },
    );

    expect(think.agents).toContain("class ChessGoalMatchDurable");
    expect(think.agents).toContain("agentTool(OpenaiChessPlayerDurable");
    expect(think.agents).toContain("agentTool(GeminiChessPlayerDurable");
    expect(think.wrangler).toContain("ChessGoalMatchDurable");
    // Same known limitation as compat/chess: result grants have no Think
    // mapping. The worker drives the match through runReactiveStep instead.
    expect(think.agents).toContain("think-result-binding-unsupported");
  });

  it("ships the goal layer in the react-free runtime file set", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-jsx-goal-runtime-"));
    emitRuntimeFiles(dir);
    expect(existsSync(join(dir, "goal.ts"))).toBe(true);
    const source = readFileSync(join(dir, "goal.ts"), "utf8");
    expect(source).toContain("export function goalReducer");
    expect(source).toContain("export function buildGoalTable");
    // Its one import resolves inside the copied set.
    expect(source).toContain('from "./tree.ts"');
    expect(existsSync(join(dir, "tree.ts"))).toBe(true);
  });
});
