import { Agent } from "../../src/agent-class.tsx";
import type { Order, SymbolName } from "./risk.ts";

export interface TraderProps extends Record<string, unknown> {
  symbol: SymbolName;
  price: number;
  observedAt: number;
  onOrder: (order: Order) => void | Promise<void>;
}

interface TraderState extends Record<string, unknown> {
  proposals: number;
}

/**
 * One isolated trader per symbol. It owns pure, offline calculation tools and
 * can only propose an order through the `onOrder` result grant; it holds no
 * execution authority and is unaware of the risk manager that seats it.
 */
export default class TraderAgent extends Agent<TraderState, TraderProps> {
  static agentName = "symbol-trader";
  model = "example/local-symbol-trader";
  displayName = "Symbol Trader";
  description = "Proposes an order for one symbol without owning execution authority.";
  initialState: TraderState = { proposals: 0 };

  getPrompt() {
    const { symbol, price, observedAt } = this.props;
    return (
      <prompt>
        <sys p={10}>
          Propose, but never execute, one {symbol} order. The Risk Manager owns final authority.
        </sys>
        <msg p={8}>Quote at t={observedAt}: ${price.toFixed(2)}.</msg>
        <msg prel={-1}>Prior proposals from this isolated trader: {this.state.proposals}.</msg>
      </prompt>
    );
  }

  getTools() {
    const { symbol, price } = this.props;
    return {
      "quote-notional": {
        description: "Calculate quote notional with no market or network access",
        execute: (input: Record<string, unknown>) => {
          const quantity = Number(input.quantity ?? 0);
          return `${symbol} notional=${(price * quantity).toFixed(2)}`;
        },
      },
      "momentum-score": {
        description: "Calculate a pure signed price delta",
        execute: (input: Record<string, unknown>) => {
          const prior = Number(input.priorPrice ?? price);
          return String(Number((price - prior).toFixed(2)));
        },
      },
    };
  }
}
