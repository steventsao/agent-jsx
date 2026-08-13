/**
 * Pure trading-desk domain: portfolio state, market marking, and the
 * parent-owned execution authority (clamp / reject / fill / circuit breaker).
 * No agent runtime imports live here — the authored RiskManagerAgent drives its
 * state exclusively through these functions, mirroring examples/chess/board.tsx.
 */

export const SYMBOLS = ["AAPL", "MSFT"] as const;
export type SymbolName = (typeof SYMBOLS)[number];
export type OrderSide = "buy" | "sell";

export interface Order extends Record<string, unknown> {
  symbol: SymbolName;
  side: OrderSide;
  quantity: number;
  rationale: string;
}

interface Fill {
  symbol: SymbolName;
  side: OrderSide;
  requested: number;
  filled: number;
  price: number;
  t: number;
}

export interface RiskState extends Record<string, unknown> {
  positions: Record<SymbolName, number>;
  prices: Partial<Record<SymbolName, number>>;
  cash: number;
  equity: number;
  peakEquity: number;
  drawdown: number;
  halted: boolean;
  haltReason: string | null;
  fills: Fill[];
  round: number;
  lastTick: number;
}

export const POSITION_LIMITS: Record<SymbolName, number> = { AAPL: 10, MSFT: 6 };
export const DRAWDOWN_LIMIT = 0.02;

export const initialRiskState: RiskState = {
  positions: { AAPL: 0, MSFT: 0 },
  prices: {},
  cash: 10_000,
  equity: 10_000,
  peakEquity: 10_000,
  drawdown: 0,
  halted: false,
  haltReason: null,
  fills: [],
  round: 0,
  lastTick: 0,
};

/** A narrated line produced by a reducer step, echoed by the demo driver. */
export interface RiskEvent {
  message: string;
}

export interface RiskTransition {
  state: RiskState;
  events: RiskEvent[];
}

function equityFor(state: RiskState, prices = state.prices): number {
  return SYMBOLS.reduce(
    (equity, symbol) => equity + state.positions[symbol] * (prices[symbol] ?? 0),
    state.cash,
  );
}

/**
 * Mark one symbol to a scripted price at tick `t`, recompute equity/drawdown,
 * and trip the circuit breaker on a drawdown breach. Deterministic.
 */
export function markPrice(state: RiskState, symbol: SymbolName, price: number, t: number): RiskTransition {
  const prices = { ...state.prices, [symbol]: price };
  const equity = equityFor(state, prices);
  const peakEquity = Math.max(state.peakEquity, equity);
  const drawdown = peakEquity === 0 ? 0 : (peakEquity - equity) / peakEquity;
  const newlyHalted = !state.halted && drawdown >= DRAWDOWN_LIMIT;
  const next: RiskState = {
    ...state,
    prices,
    equity,
    peakEquity,
    drawdown,
    halted: state.halted || newlyHalted,
    haltReason: newlyHalted
      ? `drawdown ${(drawdown * 100).toFixed(2)}% crossed ${(DRAWDOWN_LIMIT * 100).toFixed(2)}%`
      : state.haltReason,
    round: Math.floor(t / 4) + 1,
    lastTick: t,
  };
  const events: RiskEvent[] = [
    {
      message: `quote t=${t} ${symbol}=$${price.toFixed(2)} equity=$${next.equity.toFixed(2)} drawdown=${(next.drawdown * 100).toFixed(2)}%`,
    },
  ];
  if (newlyHalted) events.push({ message: `🚨 CIRCUIT BREAKER HALT: ${next.haltReason}` });
  return { state: next, events };
}

/**
 * Parent-owned execution authority: a child proposal is clamped to the
 * remaining per-symbol capacity, rejected when at limit / no quote / halted, or
 * filled. Returns the next state plus the narrated disposition marker.
 */
export function submitOrder(state: RiskState, order: Order, t: number): RiskTransition {
  if (state.halted) {
    return {
      state,
      events: [{ message: `⛔ REJECT ${order.symbol} ${order.side} ${order.quantity}: circuit breaker is open` }],
    };
  }

  const price = state.prices[order.symbol];
  if (price === undefined) {
    return { state, events: [{ message: `⛔ REJECT ${order.symbol}: no deterministic quote` }] };
  }

  const position = state.positions[order.symbol];
  const limit = POSITION_LIMITS[order.symbol];
  const capacity = order.side === "buy" ? limit - position : limit + position;
  const requested = Math.max(0, Math.floor(order.quantity));
  const filled = Math.min(requested, Math.max(0, capacity));
  if (filled === 0) {
    return {
      state,
      events: [{ message: `⛔ REJECT ${order.symbol} ${order.side} ${requested}: position ${position} is at limit ±${limit}` }],
    };
  }

  const sign = order.side === "buy" ? 1 : -1;
  const action = filled < requested ? "CLAMP" : "ACCEPT";
  const cash = state.cash - sign * filled * price;
  const positions = {
    ...state.positions,
    [order.symbol]: state.positions[order.symbol] + sign * filled,
  };
  const next = { ...state, cash, positions };
  return {
    state: {
      ...next,
      equity: equityFor(next),
      fills: [...state.fills, { symbol: order.symbol, side: order.side, requested, filled, price, t }],
    },
    events: [
      { message: `🛡 ${action} ${order.symbol}: requested ${requested}, filled ${filled} @ $${price.toFixed(2)}` },
    ],
  };
}

/** Reset the drawdown baseline and reopen proposal intake. */
export function resumeTrading(state: RiskState, t: number): RiskTransition {
  if (!state.halted) return { state, events: [{ message: "trading already active" }] };
  return {
    state: { ...state, halted: false, haltReason: null, peakEquity: state.equity, drawdown: 0 },
    events: [{ message: `▶ RESUME approved at t=${t}; drawdown baseline reset to $${state.equity.toFixed(2)}` }],
  };
}
