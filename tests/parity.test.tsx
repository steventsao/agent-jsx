/**
 * Regression guard for the soundness theorem: React render+commit and the
 * React-free evaluator must produce byte-identical desired state. Every
 * emitter change must keep this green — it's what licenses shipping
 * artifacts without React.
 */

import { describe, expect, it } from "bun:test";
import { mountAgent } from "../src/agent.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { renderPrompt } from "../src/prompt.ts";
import { collectInfra, collectPrompt } from "../src/reconciler.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import type { InfraRecord } from "../src/types.ts";
import { UptimeAgent, type UptimeState } from "../examples/uptime-agent.tsx";

// Rendering the ROOT agent means rendering its own tree (its impl) — the same
// function the generated root class calls via .spec.impl. `<UptimeAgent .../>`
// would be a subagent boundary (parent composition), not the agent itself.
const UptimeImpl = UptimeAgent.spec.impl;
const SITES = ["https://a.example", "https://b.example", "https://c.example"];
const incident: UptimeState = {
  statuses: {
    "https://a.example": { state: "up", since: 2 },
    "https://b.example": { state: "down", since: 4 },
  },
  findings: {},
};

const normalize = (records: InfraRecord[]) =>
  records
    .map(({ kind, name, config }) => ({ kind, name, config }))
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));

describe("parity: React path vs React-free evaluation", () => {
  it("produces identical infra records and prompt text", () => {
    const host = new SimHost({ statusAt: () => 200 });
    const agent = mountAgent(
      <UptimeImpl sites={SITES} store={createStore(incident)} />,
      host,
      { quiet: true }
    );
    const viaReact = normalize(
      [...host.liveRecords.values()].map(({ kind, name, config, handlers }) => ({
        kind,
        name,
        config,
        handlers,
      }))
    );
    const promptViaReact = agent.prompt(95).text;
    agent.unmount();

    const roots = evaluateTree(<UptimeImpl sites={SITES} store={createStore(incident)} />);
    const viaEvaluator = normalize(roots.flatMap((r) => collectInfra(r)));
    const promptViaEvaluator = renderPrompt(collectPrompt(roots), 95).text;

    expect(viaEvaluator.length).toBeGreaterThan(0);
    expect(JSON.stringify(viaEvaluator)).toBe(JSON.stringify(viaReact));
    expect(promptViaEvaluator).toBe(promptViaReact);
  });

  it("agent boundaries record child props as config and callbacks as handlers", () => {
    const roots = evaluateTree(<UptimeImpl sites={SITES} store={createStore(incident)} />);
    const sub = roots.flatMap((r) => collectInfra(r)).find((r) => r.kind === "subagent");
    expect(sub?.name).toBe("investigate:https://b.example");
    expect(sub?.config.kind).toBe("investigator");
    expect(sub?.config.site).toBe("https://b.example");
    expect(sub?.config.since).toBe(4);
    expect(typeof sub?.handlers.onResult).toBe("function");
  });
});
