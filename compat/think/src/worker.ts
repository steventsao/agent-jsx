// Worker entry: exports the GENERATED Think classes (created by scripts/generate.tsx)
// and routes agent requests. getModel() is not overridden here — the classes boot
// as DOs and the tests exercise getSystemPrompt()/getTools() with no model; a chat
// turn would need a getModel() override (a mock LanguageModelV3, see the spec).
import { routeAgentRequest } from "agents";
export { CoordinatorDurable, ToolWorkerDurable } from "./generated/think.cloudflare.ts";

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    return (
      (await routeAgentRequest(request, env as never, { cors: true })) ||
      new Response("agent-jsx think compat", { status: 404 })
    );
  },
};
