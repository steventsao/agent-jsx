import { Agent, callable } from "../../src/agent-class.tsx";
import {
  DRAWDOWN_LIMIT,
  initialRiskState,
  markPrice,
  POSITION_LIMITS,
  resumeTrading,
  submitOrder,
  SYMBOLS,
  type Order,
  type RiskEvent,
  type RiskState,
  type SymbolName,
} from "./risk.ts";

export interface RiskManagerProps extends Record<string, unknown> {
  desk: string;
}

/**
 * The durable risk manager owns all execution authority. It assumes no parent
 * and no children: composition decides which traders are seated and when the
 * resume affordance exists. State advances only through @callable operations
 * delegating to the pure reducers in risk.ts.
 */
export default class RiskManagerAgent extends Agent<RiskState, RiskManagerProps> {
  static agentName = "risk-manager";
  model = "example/local-risk-manager";
  displayName = "Risk Manager";
  description = "Clamps child orders and opens a drawdown circuit breaker.";
  initialState: RiskState = initialRiskState;

  get desk() {
    return this.props.desk;
  }

  get halted() {
    return this.state.halted;
  }

  get haltReason() {
    return this.state.haltReason;
  }

  get round() {
    return this.state.round;
  }

  get lastTick() {
    return this.state.lastTick;
  }

  get prices() {
    return this.state.prices;
  }

  /** The symbols with a live quote that a trader may be seated for. */
  get quotedSymbols(): SymbolName[] {
    return SYMBOLS.filter((symbol) => this.state.prices[symbol] !== undefined);
  }

  /** Mark one symbol to a scripted price. The class-contract translation of the
   * old per-symbol `<sensor onStatus>`: the demo driver ticks each symbol. */
  @callable()
  recordQuote(symbol: SymbolName, price: number, t: number): RiskEvent[] {
    const { state, events } = markPrice(this.state, symbol, price, t);
    this.setState(state);
    return events;
  }

  /** Execute (clamp / reject / fill) a child trader's proposal. This is the
   * result sink `result(submitOrder)` grants each seated trader; it returns void
   * as a child→parent result. */
  @callable()
  submitOrder(order: Order): void {
    const { state } = submitOrder(this.state, order, this.state.lastTick);
    this.setState(state);
  }

  /** Reset the drawdown baseline and reopen intake (parent-approved). */
  @callable()
  resume(t: number): RiskEvent[] {
    const { state, events } = resumeTrading(this.state, t);
    this.setState(state);
    return events;
  }

  getPrompt() {
    return (
      <prompt>
        <sys p={10}>
          RISK LIMITS: AAPL ±{POSITION_LIMITS.AAPL} shares; MSFT ±{POSITION_LIMITS.MSFT}
          shares; halt at {(DRAWDOWN_LIMIT * 100).toFixed(2)}% drawdown. Children may propose;
          only the Risk Manager executes.
        </sys>
        <msg p={9}>
          Desk {this.state.halted ? `HALTED: ${this.state.haltReason}` : "ACTIVE"}. Equity $
          {this.state.equity.toFixed(2)}; positions AAPL={this.state.positions.AAPL}, MSFT=
          {this.state.positions.MSFT}.
        </msg>
        {this.state.fills.map((fill, index) => (
          <msg key={`${fill.symbol}:${fill.t}`} prel={-(this.state.fills.length - index)}>
            old fill: t={fill.t} {fill.symbol} {fill.side} requested {fill.requested}, filled
            {fill.filled} at ${fill.price.toFixed(2)}.
          </msg>
        ))}
      </prompt>
    );
  }
}
