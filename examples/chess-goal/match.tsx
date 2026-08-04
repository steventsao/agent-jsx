/**
 * The chess-goal match root — a plain `agentComponent`, no class wrapper.
 *
 * The old chess root class existed to expose a @callable surface (handleTurn)
 * to a composition render prop. The goal layer replaces that surface with
 * provider-minted grants, so the class had nothing left to do; hierarchy and
 * authority live entirely in this one composition:
 *
 *   <GoalProvider>                          owns WHICH seat is mounted
 *     <phase name="white">  …OpenAI…        the active phase's child
 *     <phase name="black">  …Gemini…
 *     <phase name="over" />                 terminal by convention only
 *
 * The provider mints each seat's dispatch (source attribution fixed at mint
 * time), `result(...)` grants the seat handler at the boundary, and durable
 * state carries board + goal snapshot + attributed transition log side by
 * side — all plain JSON. Like examples/uptime-agent.tsx, this one component
 * is authored once and consumed three ways: live under React/SimHost, through
 * the reactive workflow executor (the worker's /step), and by the compiler.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { GoalProvider } from "../goal/goal-provider.tsx";
import {
  CHESS_GOAL_TABLE,
  declareChessGoal,
  initialChessGoalState,
  recordChessTransition,
  type ChessGoalState,
} from "./seats.tsx";

export {
  CHESS_GOAL_ID,
  CHESS_GOAL_TABLE,
  DEFAULT_MAX_PLIES,
  chessGameOver,
  declareChessGoal,
  goalStateAfterMoves,
  initialChessGoalState,
  recordChessTransition,
  seatTurnHandler,
  type ChessGoalState,
  type ChessGoalTransition,
} from "./seats.tsx";

export const ChessGoalMatch = agentComponent<{}, ChessGoalState>({
  agentName: "chess-goal-match",
  initialState: initialChessGoalState,
  model: "openrouter/openai/gpt-5-mini",
  displayName: "Agent JSX Chess Goal",
  description: "Two model seats supervised by a goal machine: phases, not code, decide who acts.",
  sampleProps: {},
  impl: ({ store }) => (
    <GoalProvider
      table={CHESS_GOAL_TABLE}
      store={store}
      onTransition={recordChessTransition(store)}
    >
      {declareChessGoal(store)}
    </GoalProvider>
  ),
});
