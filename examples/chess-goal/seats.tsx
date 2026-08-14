/**
 * Chess seats on the goal layer — the TWO-REDUCER SPLIT.
 *
 *   domain reducer  reduceChessTurn (chess.js, reused verbatim from
 *                   examples/chess/board.tsx) — decides WHETHER an outcome
 *                   happened: validates the move, advances fen/history/status,
 *                   records lastError on an illegal decision.
 *   goal reducer    src/goal.ts — decides WHAT IT MEANS: who acts next.
 *
 * The seat grant is the ONLY bridge between the two, and it is one sentence:
 * apply the domain first; only a domain-accepted move spends the phase's
 * vocabulary (`moved` while the game continues, `ended` when it is over).
 *
 * Alternation therefore lives in the TABLE, not in board code:
 *
 *   white --moved--> black --moved--> white     …and both --ended--> over
 *
 * The seats themselves are SEALED components (./players.tsx — a barrel over
 * compiler-owned companions; authored as function + profile in
 * ./*-seat.agent.tsx) — OpenAI plays white, Gemini plays black, and each
 * seat's identity, model, and initial state live inside its own record. Their
 * contract (serializable turn in, one result-granted onTurn out) already fits
 * a phase child; the only adaptation is at the composition site, where the
 * turn carries `lastError` so an illegal move re-prompts the same seat with
 * the refusal in context.
 *
 * Three refusals, three different owners:
 *   unparseable/illegal move → DOMAIN refuses (lastError; no dispatch; the
 *                              phase stays and the seat re-prompts)
 *   out-of-turn callback     → domain refuses to move AND the dispatch is
 *                              refused by the GOAL reducer as `stale`
 *   replayed raw grant       → GOAL reducer refuses it as `stale` outright
 */

import { result } from "../../src/agent-class.tsx";
import { Phase } from "../../src/agent-component.tsx";
import { createStore, type AgentStore } from "../../src/store.ts";
import {
  initialChessState,
  reduceChessTurn,
  turnFor,
  type ChessDecision,
  type ChessSide,
  type ChessState,
} from "../chess/board.tsx";
import { GeminiSeat, OpenAISeat } from "./players.tsx";
import {
  declareGoalTable,
  initGoalState,
  type GoalApi,
  type GoalDispatch,
  type GoalOwnerState,
  type GoalTransition,
} from "../goal/goal-provider.tsx";

export const CHESS_GOAL_ID = "chess-goal-match";

/** LOW ply cap by default: a runaway live match must die cheap. */
export const DEFAULT_MAX_PLIES = 16;

/** One attributed log entry: the provider's observation of a dispatch —
 *  applied or refused — plus where the BOARD stood when it happened. */
export interface ChessGoalTransition extends GoalTransition {
  ply: number;
  san: string | null;
}

/** Durable match state: the chess domain, the goal snapshot, and the
 *  attributed transition log — all plain JSON, side by side. */
export interface ChessGoalState extends ChessState, GoalOwnerState {
  log: ChessGoalTransition[];
}

export function chessGameOver(state: ChessState): boolean {
  return state.status === "checkmate" || state.status === "draw" || state.status === "max-plies";
}

/**
 * The seat grant: domain first, then goal.
 *
 * - legal move, game continues → `moved`
 * - legal move, game over      → `ended`
 * - illegal/unparseable move   → NO dispatch; lastError re-prompts the seat
 * - out-of-turn (late) call    → the domain refuses to move, and the dispatch
 *   still runs so the goal reducer records the refusal as `stale` — the grant
 *   was minted for its phase, and attribution, not trust, protects the machine.
 */
export function seatTurnHandler(
  store: AgentStore<ChessGoalState>,
  side: ChessSide,
  dispatch: GoalDispatch,
): (decision: ChessDecision | string) => void {
  return (decision) => {
    const before = store.get();
    const turn = turnFor(before);
    if (!turn || turn.side !== side) {
      dispatch("moved");
      return;
    }
    store.set((state) => reduceChessTurn(state, decision) as ChessGoalState);
    const after = store.get();
    if (after.history.length === before.history.length) return;
    dispatch(chessGameOver(after) ? "ended" : "moved");
  };
}

/**
 * The declaration — single source of truth for the runtime table AND for what
 * mounts. Every phase is declared on every render; only the ACTIVE phase's
 * seat is mounted by the provider. The inner side gate is the domain agreeing
 * with the goal (they move in lockstep), and it supplies the seat's
 * serializable turn — with `lastError` folded in as re-prompt context after an
 * illegal move. `grants`, when supplied, records every minted dispatch by
 * `phase/child` — the test/demo seam for replaying a LATE grant.
 */
export function declareChessGoal(
  store: AgentStore<ChessGoalState>,
  grants?: Map<string, GoalDispatch>,
) {
  return ({ dispatchFor }: GoalApi) => {
    const state = store.get();
    const turn = turnFor(state);
    const seatTurn = turn ? { ...turn, lastError: state.lastError } : null;
    const grant = (side: ChessSide): GoalDispatch => {
      const dispatch = dispatchFor(side, `seat:${side}`);
      grants?.set(`${side}/seat:${side}`, dispatch);
      return dispatch;
    };
    return (
      <>
        <Phase name="white" initial on={{ moved: "black", ended: "over" }}>
          {seatTurn && seatTurn.side === "white" ? (
            <OpenAISeat
              name={`white:${seatTurn.ply}`}
              turn={seatTurn}
              onTurn={result(seatTurnHandler(store, "white", grant("white")))}
            />
          ) : null}
        </Phase>
        <Phase name="black" on={{ moved: "white", ended: "over" }}>
          {seatTurn && seatTurn.side === "black" ? (
            <GeminiSeat
              name={`black:${seatTurn.ply}`}
              turn={seatTurn}
              onTurn={result(seatTurnHandler(store, "black", grant("black")))}
            />
          ) : null}
        </Phase>
        {/* Terminal by convention, not by type: no children, no outgoing edges. */}
        <Phase name="over" on={{}} />
      </>
    );
  };
}

/** Observation seam: append every dispatched outcome — applied or refused —
 *  to the durable attributed log, stamped with where the board stood. */
export function recordChessTransition(store: AgentStore<ChessGoalState>) {
  return (transition: GoalTransition): void => {
    store.set((state) => ({
      ...state,
      log: [
        ...state.log,
        { ...transition, ply: state.history.length, san: state.history.at(-1)?.san ?? null },
      ],
    }));
  };
}

// ---------------------------------------------------------------------------
// Table + initial state. The table is folded FROM the declaration above, so a
// phase that is analyzed is a phase that can mount, and vice versa.

const bootstrapState: ChessGoalState = {
  ...initialChessState,
  maxPlies: DEFAULT_MAX_PLIES,
  goal: null,
  log: [],
};

export const CHESS_GOAL_TABLE = declareGoalTable(declareChessGoal(createStore(bootstrapState)));

export const initialChessGoalState: ChessGoalState = initGoalState(CHESS_GOAL_TABLE, bootstrapState);

/** Deterministic fixture: fold legal moves through the domain reducer with the
 *  goal snapshot kept in lockstep. (At runtime the goal reducer EARNS the phase
 *  move by move; tests assert the two never disagree.) */
export function goalStateAfterMoves(moves: string[], maxPlies = DEFAULT_MAX_PLIES): ChessGoalState {
  let state: ChessGoalState = { ...initialChessGoalState, history: [], maxPlies };
  for (const move of moves) {
    state = reduceChessTurn(state, { move, note: "fixture", thought: "fixture plan" }) as ChessGoalState;
  }
  const phase = chessGameOver(state) ? "over" : turnFor(state)!.side;
  return { ...state, goal: { phase } };
}
