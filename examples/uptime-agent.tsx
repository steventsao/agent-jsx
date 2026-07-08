/**
 * The uptime agent component — authored ONCE, consumed three ways:
 *   1. examples/uptime.tsx    — live under React (dev loop, StrictMode, sim)
 *   2. examples/compile.tsx   — compiled to a cloudflare/agents class
 *   3. examples/compile.tsx   — compiled to a flue agent module
 *
 * Nothing here knows which runtime it's for. That's the contract: components
 * declare capability surface + context as a function of state; runtimes vary.
 *
 * Declared like every other agent — root or child — via `agentComponent(spec)`.
 * The spec is the single source the compiler statically analyzes: agentName
 * (class/binding), initialState (embedded), sampleProps (root props), and impl
 * (the render tree) all live next to each other in this one component file.
 */

import { agentComponent } from "../src/agent-component.tsx";
import { useAgentState } from "../src/state.ts";
import { Investigator } from "./investigator.tsx";

export interface UptimeState extends Record<string, unknown> {
  statuses: Record<string, { state: "up" | "down"; since: number }>;
  findings: Record<string, string>;
}

export const initialUptimeState: UptimeState = { statuses: {}, findings: {} };

export interface UptimeProps extends Record<string, unknown> {
  sites: string[];
}

export const UptimeAgent = agentComponent<UptimeProps, UptimeState>({
  agentName: "uptime",
  initialState: initialUptimeState,
  sampleProps: { sites: ["https://a.example", "https://b.example", "https://c.example"] },
  impl: ({ sites, store }) => {
    const { statuses, findings } = useAgentState(store);
    const down = sites.filter((site) => statuses[site]?.state === "down");

    const observe = (site: string) => (status: number, t: number) => {
      const prev = store.get().statuses[site]?.state ?? "up";
      const next = status === 200 ? "up" : "down";
      if (prev === next) return; // loopy: healthy polls emit nothing
      store.set((s) => {
        const { [site]: _dropped, ...keptFindings } = s.findings;
        return {
          ...s,
          statuses: { ...s.statuses, [site]: { state: next, since: t } },
          findings: next === "up" ? keptFindings : s.findings,
        };
      });
    };

    return (
      <>
        {sites.map((site) => (
          <sensor key={site} name={`ping:${site}`} url={site} interval={2} onStatus={observe(site)} />
        ))}

        {down.map((site) => (
          // A child AGENT composed like a component: typed props in, callback
          // out. The boundary compiles to spawn + setProps + RPC-back glue.
          <Investigator
            key={site}
            name={`investigate:${site}`}
            site={site}
            since={statuses[site]!.since}
            onResult={(result) => store.set((s) => ({ ...s, findings: { ...s.findings, [site]: result } }))}
            // Method prop: a capability the child can CALL. The closure reads
            // the parent's live state, proving freshness across the boundary.
            lookupRunbook={(s) =>
              `restart edge pods for ${s}; statuses tracked: ${Object.keys(store.get().statuses).length}`
            }
          />
        ))}

        {down.length > 0 && (
          <tool name="page-oncall" description="Escalate the active incident to a human" run={() => "paged"} />
        )}

        <schedule name="status-report" every={6} onFire={() => {}} />

        <prompt>
          <sys p={10}>
            Uptime agent for {sites.length} sites. Open a ticket per incident; skip if one exists.
          </sys>
          {down.map((site) => (
            <msg key={site} p={9}>
              INCIDENT: {site} DOWN since t={statuses[site]!.since}.{" "}
              {findings[site] ?? "Investigation in progress."}
            </msg>
          ))}
          {sites.map((site, i) => (
            <msg key={site} prel={-i - 1}>
              history: {site} routine checks nominal, p95 latency stable.
            </msg>
          ))}
        </prompt>
      </>
    );
  },
});
