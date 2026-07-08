/**
 * loopy.computer/example-uptime, re-expressed as a React component.
 *
 * loopy's shape:            here:
 *   @sensor(poll="5m")        <sensor interval onStatus>   (declared infra)
 *   emits Incident            component policy → store.set (state change)
 *   workflow on: Incident     {down.map(site => <subagent .../>)}  (mount)
 *   agent opens issue         subagent onResult → findings (state change)
 *   emits Acknowledged        site recovers → subagent unmounts (cancel)
 *
 * The whole loop is prop/state changes: sensors observe → state changes →
 * re-render → the reconciler mounts/unmounts subagents, tools, and prompt
 * context. Nothing imperative registers or cancels anything.
 *
 * Watch three things in the output:
 *   1. `+ subagent investigate:...` appears the moment a site goes down and
 *      `- subagent ...` (with in-flight work cancelled) when it recovers.
 *   2. The <tool page-oncall> capability exists ONLY while an incident is
 *      active — the agent's tool surface is derived state.
 *   3. The prompt under a 95-token budget: incident blocks (p=9) evict
 *      routine history (prel) — priompt semantics doing context triage.
 */

import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import { initialUptimeState, UptimeAgent, type UptimeState } from "./uptime-agent.tsx";

// A scripted world: site B has an outage t=4..9, site C goes dark at t=12.
const SITES = ["https://a.example", "https://b.example", "https://c.example"];
const world = {
  subagentLatency: 4,
  statusAt: (url: string, t: number) => {
    if (url.includes("b.example") && t >= 4 && t <= 9) return 500;
    if (url.includes("c.example") && t >= 12) return 0;
    return 200;
  },
};

const host = new SimHost(world);
const store = createStore<UptimeState>(initialUptimeState);
// The agentComponent boundary compiles a parent's `<UptimeAgent .../>` to a
// subagent record; to mount the agent ITSELF (its own render tree) we render
// its impl — the same function the generated root class calls via .spec.impl.
const UptimeImpl = UptimeAgent.spec.impl;
const agent = mountAgent(<UptimeImpl sites={SITES} store={store} />, host);

const BUDGET = 95;
for (let t = 1; t <= 15; t++) {
  agent.tick();
  if (t === 8 || t === 13) {
    console.log(`\n      — model turn at t=${t} —`);
    console.log(`      ${agent.think(BUDGET)}`);
    for (const b of agent.prompt(BUDGET).excluded)
      console.log(`      ✂ pruned (p=${b.priority}): ${b.text.slice(0, 52)}…`);
    console.log();
  }
}

// The world grows: a new site arrives as a ROOT PROP change — same mechanism.
console.log("\n— ops team adds a 4th site (root prop change) —");
agent.update(<UptimeImpl sites={[...SITES, "https://d.example"]} store={store} />);

console.log("\nCapability surface while c.example is still down:");
for (const key of (host.liveRecords as Map<string, unknown>).keys()) console.log(`  • ${key}`);

// Teardown reconciles to empty — including cancelling in-flight work.
console.log("\n— unmount: desired state becomes ∅ —");
agent.unmount();
