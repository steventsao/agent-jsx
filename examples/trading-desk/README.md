# Risk-gated trading desk

Two hierarchy-free class agents keep all execution authority in the parent,
following the same authoring contract as `examples/chess`.

- `RiskManagerAgent` (`risk-manager-agent.tsx`) owns the durable portfolio.
  State advances only through `@callable` operations — `recordQuote` (the
  class-contract translation of the old per-symbol sensor), `submitOrder`, and
  `resume` — each delegating to the pure reducers in `risk.ts` (clamp / reject /
  fill and the drawdown circuit breaker).
- `TraderAgent` (`trader-agent.tsx`) is one isolated trader per symbol with pure
  quote/momentum tools. It can only propose an order through its `onOrder`
  result grant; it holds no execution authority.

Hierarchy and authority live only in `composition.tsx`. A `Desk` seating
component mounts one trader per quoted symbol **only while the desk is not
halted** — when the drawdown breaker trips, every trader boundary unmounts, and
they re-mount after a resume. `result(submitOrder)` is the explicit
child-to-parent grant each trader receives; nesting alone grants nothing.

`generate.tsx` uses `emitAgentModule` to write the class-to-boundary companions
under `generated/` (re-exported by the generated barrel `agents.tsx`), plus the
Flue binding table and a Cloudflare Think target:

```sh
bun examples/trading-desk/generate.tsx
```

The demo drives the composed root turn-by-turn through the public
`runReactiveStep` execution seam (the same one `compat/chess` uses). Each tick
it marks both symbols via `recordQuote`, seats traders through the composition,
and a deterministic in-process delegate resolves each trader's proposed order,
which the risk gate clamps or rejects. A proposal takes two ticks to arrive
(the class-contract analogue of the old SimHost latency), so the circuit breaker
can cancel in-flight work. No exchange, network, or model is contacted.

Run it with:

```sh
bun examples/trading-desk/demo.tsx
```
