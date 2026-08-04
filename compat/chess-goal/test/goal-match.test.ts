/**
 * The copied composition, executed through the COPIED react-free runtime —
 * exactly the module graph the deployed Worker runs (worker.ts imports both
 * from the same generated paths). If this passes, the worker's /step loop is
 * exercising the goal layer end to end with no repo-src imports anywhere.
 */

import { describe, expect, it } from "bun:test";
import { runReactiveStep, runReactiveWorkflow } from "../src/generated/runtime/workflow-executor.ts";
import {
  ChessGoalMatch,
  goalStateAfterMoves,
  initialChessGoalState,
} from "../src/agents/match.tsx";

const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"];

describe("chess-goal worker composition (generated module graph)", () => {
  it("plays a full scripted match: phase-driven alternation to checkmate", async () => {
    const result = await runReactiveWorkflow({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: initialChessGoalState,
      delegate: (descriptor) => ({
        move: FOOLS_MATE[Number(String(descriptor.stableId).split(":")[1])]!,
        note: "scripted",
      }),
    });

    expect(result.delegated).toEqual(["white:0", "black:1", "white:2", "black:3"]);
    expect(result.state.status).toBe("checkmate");
    expect(result.state.goal).toEqual({ phase: "over" });
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
  });

  it("holds the phase on an illegal move and re-prompts with lastError", async () => {
    const first = await runReactiveStep({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: initialChessGoalState,
      delegate: () => ({ move: "e2e5", note: "illegal" }),
    });
    expect(first.state.goal).toEqual({ phase: "white" });
    expect(first.state.lastError).toContain("illegal move");

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
    expect(second.state.goal).toEqual({ phase: "black" });
  });

  it("mounts the gemini seat at the black phase and nothing once over", async () => {
    const black = await runReactiveStep({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: goalStateAfterMoves(["e2e4"]),
      delegate: (descriptor) => {
        expect(descriptor.agent).toBe("gemini-chess-player");
        return { move: "e7e5" };
      },
    });
    expect(black.state.goal).toEqual({ phase: "white" });

    const over = await runReactiveStep({
      component: ChessGoalMatch.spec.impl,
      props: {},
      initialState: goalStateAfterMoves(FOOLS_MATE),
      delegate: () => {
        throw new Error("over must delegate nothing");
      },
    });
    expect(over.descriptor).toBeNull();
  });
});
