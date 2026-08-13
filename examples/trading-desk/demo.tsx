/**
 * Offline risk-gated multi-agent trading desk, driven through the public
 * reactive execution seam (runReactiveStep), NOT SimHost.
 *
 * The RiskManagerAgent owns a durable portfolio and all execution authority.
 * Each tick the driver marks both symbols to their scripted price via the
 * `recordQuote` @callable (which may trip the drawdown circuit breaker), then
 * seats one trader per quoted symbol through the composition. A deterministic
 * in-process delegate resolves each trader's proposed order, and the risk
 * gate (submitOrder) clamps or rejects it. To mirror the original scripted
 * world, a proposal takes two ticks to arrive, so a trader seated in a round is
 * executed against the market two ticks later.
 *
 * Watch for: trader children mounting at t=1, both oversized orders CLAMPED at
 * t=3, round-two traders mounting at t=4, the drawdown circuit breaker halting
 * at t=5 (with cancelled in-flight work), the conditional resume, and at-limit
 * proposals being REJECTED after the narrated resume, with priompt eviction.
 */

import { createStore } from "../../src/store.ts";
import { collectInfra, collectPrompt } from "../../src/tree.ts";
import { renderPrompt } from "../../src/prompt.ts";
import { evaluateComponent } from "../../src/compile/evaluate.ts";
import { runReactiveStep } from "../../src/workflow-executor.ts";
import { TradingDesk, riskManagerProps } from "./composition.tsx";
import { RiskManagerAgent } from "./agents.tsx";
import {
  initialRiskState,
  submitOrder as reduceOrder,
  SYMBOLS,
  type Order,
  type RiskEvent,
  type RiskState,
  type SymbolName,
} from "./risk.ts";

const BUDGET = 64;
const PROPOSAL_LATENCY = 2;

const PRICE_PATH: Record<SymbolName, number[]> = {
  AAPL: [100, 102, 104, 103, 80, 82, 90],
  MSFT: [50, 51, 52, 51, 40, 41, 45],
};

function priceAt(symbol: SymbolName, t: number): number {
  return PRICE_PATH[symbol][Math.min(t - 1, PRICE_PATH[symbol].length - 1)]!;
}

/** The deterministic proposal a seated trader returns (the offline stand-in for
 * a model turn): buy oversized so the risk gate must clamp/reject it. */
function proposedOrder(symbol: SymbolName, observedAt: number): Order {
  return {
    symbol,
    side: "buy",
    quantity: symbol === "AAPL" ? 15 : 8,
    rationale: `deterministic momentum proposal from quote t=${observedAt}`,
  };
}

const store = createStore<RiskState>(initialRiskState);

function echo(events: RiskEvent[]): void {
  for (const event of events) console.log(`  ${event.message}`);
}

function recordQuote(symbol: SymbolName, price: number, t: number): void {
  echo(RiskManagerAgent.spec.invokeCallable("recordQuote", riskManagerProps, store, [symbol, price, t]) as RiskEvent[]);
}

function callResume(t: number): void {
  echo(RiskManagerAgent.spec.invokeCallable("resume", riskManagerProps, store, [t]) as RiskEvent[]);
}

/** Currently mounted trader boundary names (evaluated at the live state). */
function mountedTraders(): string[] {
  const roots = evaluateComponent(TradingDesk.spec.impl, { store });
  return roots
    .flatMap((root) => collectInfra(root))
    .filter((record) => record.kind === "subagent" && String(record.config.kind) === "symbol-trader")
    .map((record) => record.name);
}

/** Deliver one proposal through a reactive step: the seated trader boundary's
 * result(submitOrder) grant is realized, and the risk gate reducer produces the
 * disposition marker (CLAMP / REJECT / ACCEPT). */
async function deliver(symbol: SymbolName, observedAt: number): Promise<void> {
  const order = proposedOrder(symbol, observedAt);
  // Derive the disposition marker from the shared risk reducer (the same
  // execution logic the submitOrder callable wraps) BEFORE mutating, so the
  // CLAMP / REJECT / ACCEPT line reflects this order against the live state.
  const { events } = reduceOrder(store.get(), order, store.get().lastTick);
  // The reactive step is the state authority: the seated trader boundary's
  // result(submitOrder) grant is realized when the delegate resolves the order,
  // exactly as a live delegate would fold it in.
  const result = await runReactiveStep({
    component: TradingDesk.spec.impl,
    props: {},
    initialState: store.get(),
    delegate: () => order,
  });
  store.set(result.state);
  echo(events);
}

function printSurface(label: string): void {
  console.log(
    `  ${label}: traders=${mountedTraders().length}, resume=${store.get().halted ? "AVAILABLE" : "n/a"}`,
  );
}

function printPruned(): void {
  const roots = evaluateComponent(TradingDesk.spec.impl, { store });
  const rendered = renderPrompt(collectPrompt(roots), BUDGET);
  console.log(`  prompt budget: ${rendered.usedTokens}/${BUDGET}; ${rendered.excluded.length} block(s) pruned`);
  for (const block of rendered.excluded) {
    console.log(`  ✂ pruned (p=${block.priority}): ${block.text.slice(0, 58)}…`);
  }
}

// Pending proposals keyed by the tick they arrive on (PROPOSAL_LATENCY ticks
// after the trader is seated) — the class-contract analogue of SimHost latency.
const pending: { arriveAt: number; symbol: SymbolName; observedAt: number }[] = [];
const seatedRounds = new Set<string>();

for (let t = 1; t <= 7; t++) {
  console.log(`\n— market tick ${t} —`);
  for (const symbol of SYMBOLS) recordQuote(symbol, priceAt(symbol, t), t);

  // On a fresh halt every in-flight proposal is cancelled — the desk unmounts
  // its traders, so their pending work never executes.
  if (store.get().halted && pending.length > 0) {
    for (const item of pending) {
      console.log(`   ✂ cancelled in-flight work for trader:${item.symbol}:round-${item.observedAt}`);
      // The cancelled trader may re-mount and re-propose after a resume.
      seatedRounds.delete(`trader:${item.symbol}:round-${item.observedAt}`);
    }
    pending.length = 0;
  }

  // Seat traders for this round (only while active). Each (symbol, round) seats
  // once and schedules its proposal to arrive after the latency.
  if (!store.get().halted) {
    const round = store.get().round;
    for (const name of mountedTraders()) {
      if (seatedRounds.has(name)) continue;
      seatedRounds.add(name);
      const symbol = name.split(":")[1] as SymbolName;
      pending.push({ arriveAt: t + PROPOSAL_LATENCY, symbol, observedAt: round });
    }
  }

  // Deliver proposals arriving this tick.
  const arriving = pending.filter((item) => item.arriveAt === t);
  for (const item of arriving) await deliver(item.symbol, item.observedAt);
  if (arriving.length > 0) pending.splice(0, pending.length, ...pending.filter((item) => item.arriveAt !== t));

  if (t === 3) printPruned();
  if (t === 5) {
    printSurface("after breaker");
    printPruned();
    console.log("  client invokes the parent-approved resume operation");
    callResume(store.get().lastTick);
    // Resuming reopens intake; the just-seated round-2 traders are re-seated.
    for (const name of mountedTraders()) {
      if (seatedRounds.has(name)) continue;
      seatedRounds.add(name);
      const symbol = name.split(":")[1] as SymbolName;
      pending.push({ arriveAt: t + PROPOSAL_LATENCY, symbol, observedAt: store.get().round });
    }
    printSurface("after resume");
  }
  if (t === 7) printPruned();
}

const final = store.get();
console.log(
  `\nfinal desk: cash=$${final.cash.toFixed(2)}, equity=$${final.equity.toFixed(2)}, positions AAPL=${final.positions.AAPL} MSFT=${final.positions.MSFT}`,
);
