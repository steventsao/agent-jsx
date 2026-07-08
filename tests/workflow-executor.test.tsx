/**
 * v0.5 contract — the reactive workflow EXECUTOR (RED until implemented).
 *
 * `runReactiveWorkflow` is the react-free runtime piece the generated flue
 * workflow calls: flue has no state→render loop, so the executor converges
 * one turn's worth of dynamic composition:
 *
 *   round: evaluate component at state (local merging store, boundStore
 *   semantics) → collect subagent records → FRESH = stableIds not yet
 *   delegated → delegate each in tree order (session.task in production)
 *   → invoke that record's own onResult handler with the result (the
 *   callback prop realized) → state mutates → next round. Terminate when a
 *   round has no fresh work; throw past maxRounds (loud, not silent).
 *
 * Contract location: src/workflow-executor.ts (react-free; shipped into
 * artifacts by emitRuntimeFiles as runtime/workflow-executor.ts).
 *
 * THE PARITY THEOREM (v0.5): given the same incident state, the workflow
 * executor and the live React/SimHost path must produce the SAME delegated
 * stableIds and byte-identical final state. Scenario is recovery-free on
 * purpose — despawn/cancellation is v1 (CF) semantics; a completed
 * session.task cannot be unspawned. Do not weaken these assertions.
 */

import { describe, expect, it } from "bun:test";
import { mountAgent } from "../src/agent.ts";
import { SimHost } from "../src/sim-host.ts";
import { createStore, useAgentState, type AgentStore } from "../src/state.ts";
import { runReactiveWorkflow, type SpawnDescriptor } from "../src/workflow-executor.ts";
import { UptimeAgent, type UptimeState } from "../examples/uptime-agent.tsx";

const SITES = ["https://a.example", "https://b.example", "https://c.example"];

/** Mirror SimHost's canned investigator result so states compare bytewise. */
const simHostResult = (d: SpawnDescriptor) =>
  `[${d.stableId}] investigated ${JSON.stringify({ kind: d.agent, ...d.input })} → root cause: upstream dependency`;

describe("runReactiveWorkflow", () => {
  it("PARITY: same delegations and byte-identical final state as the live path", async () => {
    // Live path: b.example goes down at t=4 and stays down; investigation
    // (latency 4) completes at t=8. No recovery.
    const host = new SimHost({
      subagentLatency: 4,
      statusAt: (url, t) => (url.includes("b.example") && t >= 4 ? 500 : 200),
    });
    const liveStore = createStore<UptimeState>({ statuses: {}, findings: {} });
    const UptimeImpl = UptimeAgent.spec.impl;
    const agent = mountAgent(<UptimeImpl sites={SITES} store={liveStore} />, host, { quiet: true });
    for (let t = 1; t <= 8; t++) agent.tick();
    const liveFinal = JSON.parse(liveStore.snapshot()) as UptimeState;
    const liveSpawned = [...host.liveRecords.keys()]
      .filter((k) => k.startsWith("subagent:"))
      .map((k) => k.slice("subagent:".length));
    agent.unmount();

    // Workflow path: enters at the same incident state the sensor produced.
    const result = await runReactiveWorkflow<{ sites: string[]; store: AgentStore<UptimeState> }, UptimeState>({
      component: UptimeAgent.spec.impl as never,
      props: { sites: SITES } as never,
      initialState: {
        statuses: { "https://b.example": { state: "down", since: 4 } },
        findings: {},
      },
      delegate: async (d) => simHostResult(d),
    });

    expect(result.delegated).toEqual(liveSpawned);
    expect(result.delegated).toEqual(["investigate:https://b.example"]);
    expect(JSON.stringify(result.state)).toBe(JSON.stringify(liveFinal));
    expect(result.rounds).toBe(1);
    // The final prompt reflects the folded-in finding, not the initial state.
    expect(result.prompt).toContain("INCIDENT");
    expect(result.prompt).toContain("root cause");
  });

  it("converges over multiple rounds when a result mounts a new child", async () => {
    interface S extends Record<string, unknown> {
      rootCause: string | null;
      escalated: string | null;
    }
    function Escalation({ store }: { store: AgentStore<S> }) {
      const { rootCause, escalated } = useAgentState(store);
      return (
        <>
          {!rootCause && (
            <subagent name="diagnose" kind="diagnoser" onResult={(r: string) => store.set({ rootCause: r })} />
          )}
          {rootCause && !escalated && (
            <subagent name="escalate" kind="escalator" onResult={(r: string) => store.set({ escalated: r })} />
          )}
          <prompt>
            <sys p={10}>Handle the incident.</sys>
          </prompt>
        </>
      );
    }

    const result = await runReactiveWorkflow<{ store: AgentStore<S> }, S>({
      component: Escalation as never,
      props: {} as never,
      initialState: { rootCause: null, escalated: null },
      delegate: async (d) => `done:${d.stableId}`,
    });

    expect(result.delegated).toEqual(["diagnose", "escalate"]);
    expect(result.rounds).toBe(2);
    expect(result.state).toEqual({ rootCause: "done:diagnose", escalated: "done:escalate" });
  });

  it("throws loudly past maxRounds instead of spinning", async () => {
    interface S extends Record<string, unknown> {
      count: number;
    }
    function Runaway({ store }: { store: AgentStore<S> }) {
      const { count } = useAgentState(store);
      return (
        <subagent
          name={`n${count}`}
          kind="spawner"
          onResult={() => store.set((s) => ({ ...s, count: s.count + 1 }))}
        />
      );
    }
    await expect(
      runReactiveWorkflow<{ store: AgentStore<S> }, S>({
        component: Runaway as never,
        props: {} as never,
        initialState: { count: 0 },
        delegate: async () => "ok",
        maxRounds: 3,
      })
    ).rejects.toThrow(/maxRounds|rounds/i);
  });
});
