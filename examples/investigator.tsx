/**
 * A child agent, written exactly like the parent: a component file.
 *
 * Its props ARE its API:
 *   - `site`, `since` — serializable input from the parent (compiled to
 *     setProps RPC; a parent re-render that changes them updates the child).
 *   - `onResult` — the line back up (compiled to generated parent-dispatch
 *     RPC; here in the sim it's just a closure).
 *
 * It has its own state, its own tools, its own prompt, its own schedule —
 * none of which leak into the parent's tree. The boundary is the contract.
 */

import { agentComponent } from "../src/agent-component.tsx";
import { useAgentState } from "../src/state.ts";

export interface InvestigatorProps {
  site: string;
  since: number;
  onResult: (result: string) => void | Promise<void>;
  /** METHOD PROP — a parent capability passed down like any other prop.
   *  Compiles to request/response RPC across the agent boundary: the child
   *  awaits it like a local function; the parent's freshest closure computes
   *  the answer (args and return must be structured-cloneable). The props a
   *  parent passes ARE the child's capability grant. */
  lookupRunbook?: (site: string) => string | Promise<string>;
}

export interface InvestigatorState extends Record<string, unknown> {
  checked: string[];
}

export const Investigator = agentComponent<InvestigatorProps, InvestigatorState>({
  agentName: "investigator",
  initialState: { checked: [] },
  capabilities: {
    onResult: { kind: "result" },
    lookupRunbook: { kind: "method" },
  },
  sampleProps: { site: "https://example.com", since: 0, onResult: () => {} },
  impl: ({ site, since, onResult, lookupRunbook, store }) => {
    const { checked } = useAgentState(store);
    return (
      <>
        <tool
          name="fetch-logs"
          description="Pull recent logs for the affected site"
          run={() => `logs(${site})`}
        />
        <tool
          name="check-upstream"
          description="Probe upstream dependencies"
          run={() => `upstream(${site})`}
        />
        {/* SLA deadline: consult the parent's runbook (a method prop — RPC
            with a return value), then report back. */}
        <schedule
          name="sla-deadline"
          every={8}
          onFire={async () => {
            const runbook = lookupRunbook ? await lookupRunbook(site) : "no runbook";
            return onResult(`[${site}] no root cause within SLA — escalating (runbook: ${runbook})`);
          }}
        />
        <prompt>
          <sys p={10}>
            You investigate ONE outage: {site}, down since t={since}. Find the root cause, then
            call onResult exactly once.
          </sys>
          <msg p={7}>Checked so far: {checked.length ? checked.join(", ") : "nothing yet"}.</msg>
          <msg prel={-1}>Playbook: DNS → upstream deps → recent deploys → capacity.</msg>
        </prompt>
      </>
    );
  },
});
