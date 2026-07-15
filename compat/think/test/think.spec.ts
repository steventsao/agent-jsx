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
import type { LanguageModel } from "ai";

type ThinkAgent = {
  state: Record<string, unknown>;
  getSystemPrompt(): string;
  getTools(): Record<string, { description?: string; execute?: unknown }>;
  runTurnWithTrace(
    input: string,
    props?: Record<string, unknown>,
  ): Promise<{ requestId: string; text: string; reasoning: string }>;
};

declare module "cloudflare:test" {
  interface ProvidedEnv {
    COORDINATOR: DurableObjectNamespace;
    TOOL_WORKER: DurableObjectNamespace;
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      COORDINATOR: DurableObjectNamespace;
      TOOL_WORKER: DurableObjectNamespace;
    }
  }
}

const coordinator = async () =>
  (await getAgentByName(env.COORDINATOR as never, "coord")) as never as DurableObjectStub;
const worker = async () =>
  (await getAgentByName(env.TOOL_WORKER as never, "w")) as never as DurableObjectStub;

function structuredChildModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "structured-child",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by Think's streaming turn");
    },
    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "answer" });
          controller.enqueue({
            type: "text-delta",
            id: "answer",
            delta: '{"answer":"native agentTool result"}',
          });
          controller.enqueue({ type: "text-end", id: "answer" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 4, outputTokens: 4 },
          });
          controller.close();
        },
      });
      return { stream };
    },
  } as LanguageModel;
}

function parentToolCallingModel(): LanguageModel {
  let calls = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "parent-tool-caller",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by Think's streaming turn");
    },
    async doStream(options: Record<string, unknown>) {
      calls++;
      const prompt = JSON.stringify(options.prompt ?? []);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          if (calls === 1) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "stable-onCall-1",
              toolName: "onCall",
              input: JSON.stringify({ query: "typed bindings" }),
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 4, outputTokens: 4 },
            });
          } else {
            if (!prompt.includes("native agentTool result")) {
              controller.error(new Error(`parent did not receive structured child output: ${prompt}`));
              return;
            }
            controller.enqueue({ type: "text-start", id: "parent-answer" });
            controller.enqueue({
              type: "text-delta",
              id: "parent-answer",
              delta: "parent received native agentTool result",
            });
            controller.enqueue({ type: "text-end", id: "parent-answer" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 4, outputTokens: 4 },
            });
          }
          controller.close();
        },
      });
      return { stream };
    },
  } as LanguageModel;
}

function reasoningModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "reasoning-player",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by Think's streaming turn");
    },
    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "reasoning-start", id: "thought" });
          controller.enqueue({ type: "reasoning-delta", id: "thought", delta: "Control the center." });
          controller.enqueue({ type: "reasoning-end", id: "thought" });
          controller.enqueue({ type: "text-start", id: "move" });
          controller.enqueue({ type: "text-delta", id: "move", delta: '{"move":"e2e4","note":"central space"}' });
          controller.enqueue({ type: "text-end", id: "move" });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 4, outputTokens: 8 },
          });
          controller.close();
        },
      });
      return { stream };
    },
  } as LanguageModel;
}

describe("generated THINK classes on real @cloudflare/think + agents/agent-tools", () => {
  it("boots both Think subclasses as durable objects", async () => {
    // Reachable stub via getAgentByName (the production path) + an in-DO read =
    // the class constructed and Agent state initialised, on the real 0.17 stack.
    const turns = await runInDurableObject(
      await coordinator(),
      (instance) => (instance as unknown as ThinkAgent).state?.turns,
    );
    expect(turns).toBe(0); // Coordinator.spec.initialState
    const answered = await runInDurableObject(
      await worker(),
      (instance) => (instance as unknown as ThinkAgent).state?.answered,
    );
    expect(answered).toBe(false); // Worker.spec.initialState
  });

  it("getSystemPrompt() renders the component's context window over state", async () => {
    const prompt = await runInDurableObject(
      await coordinator(),
      (instance) => (instance as unknown as ThinkAgent).getSystemPrompt(),
    );
    // From Coordinator's <sys>/<msg> (priompt-rendered), not Think's default.
    expect(prompt).toContain("Coordinate the task");
    expect(prompt).toContain("turns so far");
  });

  it("getTools() registers the slot child as an agentTool NAMED BY THE PROP KEY", async () => {
    const info = await runInDurableObject(await coordinator(), (instance) => {
      const a = instance as unknown as ThinkAgent;
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
    const keys = await runInDurableObject(
      await worker(),
      (instance) => Object.keys((instance as unknown as ThinkAgent).getTools()),
    );
    expect(keys).toEqual([]);
  });

  it("collects Think reasoning and text through the generated turn bridge", async () => {
    const trace = await runInDurableObject(await worker(), async (instance) => {
      const agent = instance as unknown as ThinkAgent & { getModel: () => LanguageModel };
      agent.getModel = reasoningModel;
      return await agent.runTurnWithTrace("Play one move", { query: "center" });
    });

    expect(trace.requestId).toBeTruthy();
    expect(trace.reasoning).toBe("Control the center.");
    expect(trace.text).toBe('{"move":"e2e4","note":"central space"}');
  });

  it("executes the generated native agentTool and returns schema-validated child output", async () => {
    // Supply the test-only child model on the live generated class. Production
    // consumers override getModel the same way; the emitted binding stays the
    // exact Coordinator.getTools() -> agentTool(ToolWorkerDurable, ...) path.
    await runInDurableObject(await worker(), (instance) => {
      (Object.getPrototypeOf(instance) as { getModel: () => LanguageModel }).getModel = structuredChildModel;
    });

    const messages = await runInDurableObject(await coordinator(), async (instance) => {
      const agent = instance as unknown as ThinkAgent & {
        getModel: () => LanguageModel;
        runTurn(options: { input: string; mode: "wait" }): Promise<unknown>;
        getMessages(): Promise<unknown[]>;
      };
      agent.getModel = parentToolCallingModel;
      await agent.runTurn({ input: "delegate through onCall", mode: "wait" });
      return await agent.getMessages();
    });
    expect(JSON.stringify(messages)).toContain("parent received native agentTool result");
  });
});
