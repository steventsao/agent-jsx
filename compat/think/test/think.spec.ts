/**
 * THE think compat proof: the generated `class X extends Think<Env>` classes run
 * on the REAL @cloudflare/think@0.12.1 + agents@0.17.3 inside real workerd
 * (vitest-pool-workers — headless, no dev server, no live LLM).
 *
 * What is provable WITHOUT a model (the seam: getModel inherits Think's throwing
 * default, so the class boots; getSystemPrompt/getTools need no turn):
 *   1. BOOT — both Think subclasses instantiate as DOs (getAgentByName).
 *   2. getSystemPrompt() — returns the component's rendered context window.
 *   3. getTools() registration — the slot binding is an `agentTool` NAMED BY THE
 *      PROP KEY (onCall), carrying a description + an execute (the AI-SDK Tool).
 *
 * The tool-call → child-facet SPAWN (agentTool.execute → subAgent) needs an
 * active turn driven by a mock LanguageModelV3 (playground pattern); that is the
 * frontier, documented in docs/think-target.md and asserted at emitted-string
 * level in tests/emit-think.test.tsx. Do not weaken these assertions.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

type ThinkAgent = {
  state: Record<string, unknown>;
  getSystemPrompt(): string;
  getTools(): Record<string, { description?: string; execute?: unknown }>;
};

declare module "cloudflare:test" {
  interface ProvidedEnv {
    COORDINATOR: DurableObjectNamespace;
    TOOL_WORKER: DurableObjectNamespace;
  }
}

const coordinator = async () =>
  (await getAgentByName(env.COORDINATOR as never, "coord")) as never as DurableObjectStub;
const worker = async () =>
  (await getAgentByName(env.TOOL_WORKER as never, "w")) as never as DurableObjectStub;

describe("generated THINK classes on real @cloudflare/think + agents/agent-tools", () => {
  it("boots both Think subclasses as durable objects", async () => {
    // Reachable stub via getAgentByName (the production path) + an in-DO read =
    // the class constructed and Agent state initialised, on the real 0.17 stack.
    const turns = await runInDurableObject(await coordinator(), (a: ThinkAgent) => a.state?.turns);
    expect(turns).toBe(0); // Coordinator.spec.initialState
    const answered = await runInDurableObject(await worker(), (a: ThinkAgent) => a.state?.answered);
    expect(answered).toBe(false); // Worker.spec.initialState
  });

  it("getSystemPrompt() renders the component's context window over state", async () => {
    const prompt = await runInDurableObject(await coordinator(), (a: ThinkAgent) => a.getSystemPrompt());
    // From Coordinator's <sys>/<msg> (priompt-rendered), not Think's default.
    expect(prompt).toContain("Coordinate the task");
    expect(prompt).toContain("turns so far");
  });

  it("getTools() registers the slot child as an agentTool NAMED BY THE PROP KEY", async () => {
    const info = await runInDurableObject(await coordinator(), (a: ThinkAgent) => {
      const tools = a.getTools();
      return {
        keys: Object.keys(tools),
        description: tools.onCall?.description,
        hasExecute: typeof tools.onCall?.execute === "function",
      };
    });
    expect(info.keys).toContain("onCall"); // the prop key, not the child kind
    // schema'd/described by the CHILD's spec (Worker.spec.description)
    expect(info.description).toBe("Answer a research query from the document corpus.");
    expect(info.hasExecute).toBe(true); // a real AI-SDK Tool (agentTool)
  });

  it("a bare Think (no getModel) exposes an empty getTools on the leaf child", async () => {
    // ToolWorkerDurable is a leaf → getTools inherits Think's {} default.
    const keys = await runInDurableObject(await worker(), (a: ThinkAgent) => Object.keys(a.getTools()));
    expect(keys).toEqual([]);
  });
});
