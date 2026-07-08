/**
 * Live demo worker for the DEPLOYED compiled agents.
 *
 *   GET  /            info
 *   GET  /state       parent state + every live child's state
 *   GET  /prompt      the parent's current context window (priompt-rendered)
 *   POST /incident?site=   mark a site down (merge-safe applyState)
 *   POST /recover?site=    mark a site up
 *
 * Everything else — sensors polling real URLs, children spawning/despawning,
 * SLA callbacks folding findings back into state — happens inside the agents
 * with no code here. This file is a window, not a controller.
 */

import { getAgentByName } from "agents";
export { UptimeDurable, InvestigatorDurable } from "./deploy-generated/uptime.cloudflare.ts";

interface Env {
  UPTIME: DurableObjectNamespace;
  INVESTIGATOR: DurableObjectNamespace;
}

type AgentStub = {
  readState(): Promise<Record<string, any>>;
  applyState(update: Record<string, unknown>): Promise<void>;
  reconcile(): Promise<void>;
  promptFor(budget: number): Promise<string>;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parent = (await getAgentByName(env.UPTIME as never, "main")) as unknown as AgentStub;

    if (url.pathname === "/state") {
      const state = await parent.readState();
      const children: Record<string, unknown> = {};
      for (const c of (state.__children ?? []) as { name: string }[]) {
        const child = (await getAgentByName(env.INVESTIGATOR as never, c.name)) as unknown as AgentStub;
        children[c.name] = await child.readState();
      }
      return Response.json({ state, children });
    }

    if (url.pathname === "/prompt") {
      return new Response(await parent.promptFor(95));
    }

    if (req.method === "POST" && (url.pathname === "/incident" || url.pathname === "/recover")) {
      const site = url.searchParams.get("site") ?? "https://agent-jsx-down.invalid";
      const next = url.pathname === "/incident" ? "down" : "up";
      const s = await parent.readState();
      await parent.applyState({
        statuses: { ...s.statuses, [site]: { state: next, since: Date.now() } },
      });
      return Response.json({ ok: true, site, state: next });
    }

    await parent.reconcile(); // first touch boots sensors/schedules
    return new Response(
      "agent-jsx live demo — compiled from React-authored agent components.\n" +
        "GET /state · GET /prompt · POST /incident?site= · POST /recover?site=\n"
    );
  },
};
