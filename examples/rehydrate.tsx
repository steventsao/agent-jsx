/**
 * The two objections that killed "React as agent runtime" elsewhere,
 * answered by construction:
 *
 * A. HIBERNATION — "the fiber tree dies with the process; closures don't
 *    serialize." Right — so don't serialize them. Persist only agent STATE
 *    and the host's infra CONFIGS (both JSON). On wake, re-render the same
 *    code over the restored state: the commit sweep converges (rebind ops,
 *    zero duplicate creates) and fresh closures re-attach — the same way
 *    react-dom never serializes onClick. This is what cloudflare/agents
 *    patches imperatively with `schedule(..., { idempotent: true })` and
 *    onStart() warnings; desired-state reconciliation makes it structural.
 *
 * B. STRICT MODE — the sibling repo (agents-as-components, example 06)
 *    showed StrictMode double-firing paid LLM calls when agent steps live
 *    in useEffect. Here there are NO effects: render is pure declaration,
 *    and infra mutation happens once per COMMIT. StrictMode doubles renders;
 *    host ops stay identical.
 */

import { StrictMode } from "react";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore, useAgentState, type AgentStore } from "../src/state.ts";

interface State extends Record<string, unknown> {
  statuses: Record<string, { state: "up" | "down"; since: number }>;
  findings: Record<string, string>;
}

function Monitor({
  sites,
  store,
  probe,
}: {
  sites: string[];
  store: AgentStore<State>;
  probe?: { renders: number };
}) {
  if (probe) probe.renders++;
  const { statuses, findings } = useAgentState(store);
  const down = sites.filter((s) => statuses[s]?.state === "down");

  return (
    <>
      {sites.map((site) => (
        <sensor
          key={site}
          name={`ping:${site}`}
          url={site}
          interval={2}
          onStatus={(status, t) => {
            const prev = store.get().statuses[site]?.state ?? "up";
            const next = status === 200 ? "up" : "down";
            if (prev !== next)
              store.set((s) => ({ ...s, statuses: { ...s.statuses, [site]: { state: next, since: t } } }));
          }}
        />
      ))}
      {down.map((site) => (
        <subagent
          key={site}
          name={`investigate:${site}`}
          kind="investigator"
          input={{ site }}
          onResult={(r: string) => store.set((s) => ({ ...s, findings: { ...s.findings, [site]: r } }))}
        />
      ))}
      <schedule name="report" every={6} onFire={() => {}} />
      <prompt>
        <sys p={10}>Monitor {sites.join(", ")}.</sys>
        {down.map((site) => (
          <msg key={site} p={9}>
            INCIDENT: {site} down. {findings[site] ?? "Investigating."}
          </msg>
        ))}
      </prompt>
    </>
  );
}

const SITES = ["https://a.example", "https://b.example"];
const world = {
  subagentLatency: 4,
  statusAt: (url: string, t: number) => (url.includes("b.example") && t >= 4 ? 500 : 200),
};

// ---------------------------------------------------------------------------
console.log("— process 1: mount, incident begins, then the process dies —");
const host1 = new SimHost(world);
const store1 = createStore<State>({ statuses: {}, findings: {} });
const agent1 = mountAgent(<Monitor sites={SITES} store={store1} />, host1);
for (let t = 1; t <= 5; t++) agent1.tick();

const infraSnapshot = host1.snapshot();
const stateSnapshot = store1.snapshot();
console.log(`\n💾 persisted: infra=${infraSnapshot.length}B, state=${stateSnapshot.length}B (JSON only — no closures, no fiber tree)`);
// NOTE: no unmount — the process just dies. Unmount would mean "tear down my
// infrastructure"; hibernation means "the runtime keeps it".

// ---------------------------------------------------------------------------
console.log("\n— process 2: restore state + infra, re-render the SAME code —");
const host2 = SimHost.restore(infraSnapshot, world, 5);
const store2 = createStore<State>(JSON.parse(stateSnapshot));
const agent2 = mountAgent(<Monitor sites={SITES} store={store2} />, host2);

const dupes = host2.opLog.filter((o) => o.op === "create" || o.op === "remove");
console.log(
  dupes.length === 0
    ? "✓ converged: every record rebound, zero duplicate creates, zero spurious removes"
    : `✗ diverged: ${JSON.stringify(dupes)}`
);

for (let t = 6; t <= 9; t++) agent2.tick();
console.log(`\nafter wake, the re-armed investigation completed and re-entered the prompt:`);
console.log(`  ${agent2.think(120)}`);
agent2.unmount();

// ---------------------------------------------------------------------------
console.log("\n— StrictMode: double renders, identical infra ops —");
function mountCounted(strict: boolean) {
  const host = new SimHost(world);
  const store = createStore<State>({ statuses: {}, findings: {} });
  const probe = { renders: 0 };
  const app = <Monitor sites={SITES} store={store} probe={probe} />;
  const agent = mountAgent(strict ? <StrictMode>{app}</StrictMode> : app, host, { quiet: true });
  agent.unmount();
  // unmount removes everything; count only the mount-time ops
  return { renders: probe.renders, ops: host.opLog.filter((o) => o.op === "create").length };
}
const plain = mountCounted(false);
const strict = mountCounted(true);
console.log(`  plain:      ${plain.renders} render(s), ${plain.ops} host op(s)`);
console.log(`  strictmode: ${strict.renders} render(s), ${strict.ops} host op(s)`);
console.log(
  strict.ops === plain.ops
    ? "✓ commits are the effect boundary: double render, single reconcile — no double-paid side effects\n  (contrast: agents-as-components example 06, where StrictMode double-fired LLM calls in useEffect)"
    : "✗ ops diverged under StrictMode"
);
