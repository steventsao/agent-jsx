import { composeAgent, result } from "../../src/agent-class.tsx";
import { Agent } from "../../src/agent-component.tsx";
import { RiskManagerAgent, TraderAgent } from "./agents.tsx";
import type { SymbolName } from "./risk.ts";

export { initialRiskState, type RiskState } from "./risk.ts";

export const riskManagerProps = { desk: "equities" } as const;

interface SeatInput {
  symbol: SymbolName;
  price: number;
}

/**
 * Seats one isolated trader per quoted symbol — but ONLY while the desk is not
 * halted. When the circuit breaker trips, `halted` is true and Desk seats no
 * traders, so every trader boundary unmounts; when the desk resumes they mount
 * again. This conditional seating is the entire point of the example.
 */
function Desk({
  halted,
  seats,
  round,
  observedAt,
  onOrder,
}: {
  halted: boolean;
  seats: SeatInput[];
  round: number;
  observedAt: number;
  onOrder: (order: import("./risk.ts").Order) => void | Promise<void>;
}) {
  if (halted) return null;
  return (
    <>
      {seats.map((seat) => (
        <Agent
          key={seat.symbol}
          agentClass={TraderAgent}
          name={`trader:${seat.symbol}:round-${round}`}
          symbol={seat.symbol}
          price={seat.price}
          observedAt={observedAt}
          onOrder={onOrder}
        />
      ))}
    </>
  );
}

/**
 * Hierarchy and authority exist only here. The render prop exposes the risk
 * manager's getters and its `submitOrder` @callable; `result(submitOrder)` is
 * the explicit child-to-parent grant each trader receives.
 */
export const TradingDesk = composeAgent(
  <RiskManagerAgent name="risk" {...riskManagerProps}>
    {({ halted, quotedSymbols, prices, lastTick, round, submitOrder }) => (
      <Desk
        halted={halted}
        round={round}
        observedAt={lastTick}
        seats={quotedSymbols.map((symbol: SymbolName) => ({ symbol, price: prices[symbol]! }))}
        onOrder={result(submitOrder)}
      />
    )}
  </RiskManagerAgent>,
);
