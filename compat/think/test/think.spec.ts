/**
 * THE think compat proof: the generated `class X extends Think<Env>` classes run
 * on the REAL @cloudflare/think + agents packages inside real workerd
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
import { getAgentByName, getSubAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { ClassWorkerDurable } from "../src/generated/class-agent-tool.cloudflare.ts";

type ThinkAgent = {
  state: Record<string, unknown>;
  setState(state: Record<string, unknown>): void;
  getSystemPrompt(): string;
  getTools(): Record<string, {
    description?: string;
    execute?: unknown;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>;
  runTurnWithTrace(
    input: string,
    props?: Record<string, unknown>,
  ): Promise<{ requestId: string; text: string; reasoning: string }>;
};

declare module "cloudflare:test" {
  interface ProvidedEnv {
    COORDINATOR: DurableObjectNamespace;
    CLASS_COORDINATOR: DurableObjectNamespace;
    CLASS_WORKER: DurableObjectNamespace;
    DEFINITION_AGENT: DurableObjectNamespace;
    DYNAMIC_TOOLS: DurableObjectNamespace;
    MCP_BARE_TOKEN: DurableObjectNamespace;
    MCP_PREFIXED_TOKEN: DurableObjectNamespace;
    SKILL_PROMPT: DurableObjectNamespace;
    TOOL_WORKER: DurableObjectNamespace;
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      COORDINATOR: DurableObjectNamespace;
      CLASS_COORDINATOR: DurableObjectNamespace;
      CLASS_WORKER: DurableObjectNamespace;
      DEFINITION_AGENT: DurableObjectNamespace;
      DYNAMIC_TOOLS: DurableObjectNamespace;
      MCP_BARE_TOKEN: DurableObjectNamespace;
      MCP_PREFIXED_TOKEN: DurableObjectNamespace;
      SKILL_PROMPT: DurableObjectNamespace;
      TOOL_WORKER: DurableObjectNamespace;
    }
  }
}

const coordinator = async () =>
  (await getAgentByName(env.COORDINATOR as never, "coord")) as never as DurableObjectStub;
const classCoordinator = async () =>
  (await getAgentByName(env.CLASS_COORDINATOR as never, "class-coord")) as never as DurableObjectStub;
const dynamicTools = async () =>
  (await getAgentByName(env.DYNAMIC_TOOLS as never, "dynamic")) as never as DurableObjectStub;
const definitionAgent = async () =>
  (await getAgentByName(env.DEFINITION_AGENT as never, "definition")) as never as DurableObjectStub;
const mcpBareToken = async () =>
  (await getAgentByName(env.MCP_BARE_TOKEN as never, "mcp-bare")) as never as DurableObjectStub;
const mcpPrefixedToken = async () =>
  (await getAgentByName(env.MCP_PREFIXED_TOKEN as never, "mcp-prefixed")) as never as DurableObjectStub;
const skillPrompt = async () =>
  (await getAgentByName(env.SKILL_PROMPT as never, "skill-prompt")) as never as DurableObjectStub;
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

const classToolCallId = "class-props-tool-call-1";
const classToolRunId = `agent-tool:${classToolCallId}`;
const modelSuppliedClassQuery = "MODEL-SUPPLIED-CLASS-QUERY-9f21";

function classParentToolCallingModel(): LanguageModel {
  let calls = 0;
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "class-parent-tool-caller",
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
              toolCallId: classToolCallId,
              toolName: "class_worker",
              input: JSON.stringify({ query: modelSuppliedClassQuery }),
            });
            controller.enqueue({
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 4, outputTokens: 4 },
            });
          } else {
            if (
              !prompt.includes("class child completed::validated-once") ||
              prompt.includes("validated-once::validated-once")
            ) {
              controller.error(new Error(`parent did not receive class child output: ${prompt}`));
              return;
            }
            controller.enqueue({ type: "text-start", id: "class-parent-answer" });
            controller.enqueue({
              type: "text-delta",
              id: "class-parent-answer",
              delta: "parent received class child output validated once",
            });
            controller.enqueue({ type: "text-end", id: "class-parent-answer" });
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

function classChildModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "class-child",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by Think's streaming turn");
    },
    async doStream() {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "class-answer" });
          controller.enqueue({
            type: "text-delta",
            id: "class-answer",
            delta: '{"answer":"class child completed"}',
          });
          controller.enqueue({ type: "text-end", id: "class-answer" });
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

function skillPromptModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "skill-prompt",
    supportedUrls: {},
    doGenerate() {
      throw new Error("doGenerate is not used by Think's streaming turn");
    },
    async doStream(options: Record<string, unknown>) {
      const prompt = JSON.stringify(options.prompt ?? []);
      const liveMarker = "AUTHORED_SKILL_PROMPT::live";
      const liveCount = prompt.split(liveMarker).length - 1;
      if (
        liveCount !== 1 ||
        prompt.includes("AUTHORED_SKILL_PROMPT::startup") ||
        !prompt.includes("Available skills") ||
        !prompt.includes("review")
      ) {
        throw new Error(`skill prompt composition was incomplete or stale: ${prompt}`);
      }
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "skill-answer" });
          controller.enqueue({
            type: "text-delta",
            id: "skill-answer",
            delta: "authored prompt and skill catalog composed",
          });
          controller.enqueue({ type: "text-end", id: "skill-answer" });
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

describe("generated THINK classes on real @cloudflare/think + agents/agent-tools", () => {
  it("boots both Think subclasses as durable objects", async () => {
    // Reachable stub via getAgentByName (the production path) + an in-DO read =
    // the class constructed and Agent state initialised, on the real current stack.
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

  it("rejects invalid persisted MCP callback configuration before connecting", async () => {
    await expect(
      (async () => runInDurableObject(
          await definitionAgent(),
          (instance) => (instance as unknown as ThinkAgent).state?.enabled,
        ))(),
    ).rejects.toThrow("callbackHost must be an HTTP(S) origin without credentials");
  });

  it("rejects bare token query keys returned by the deployment MCP resolver", async () => {
    await expect(
      (async () => runInDurableObject(
          await mcpBareToken(),
          (instance) => (instance as unknown as ThinkAgent).state,
        ))(),
    ).rejects.toThrow('sensitive MCP credential query parameter "token"');
  });

  it("rejects prefixed token query keys returned by the deployment MCP resolver", async () => {
    await expect(
      (async () => runInDurableObject(
          await mcpPrefixedToken(),
          (instance) => (instance as unknown as ThinkAgent).state,
        ))(),
    ).rejects.toThrow('sensitive MCP credential query parameter "github_token"');
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

  it("re-renders raw tools from state without flattening their schema or result", async () => {
    const observed = await runInDurableObject(await dynamicTools(), async (instance) => {
      const agent = instance as unknown as ThinkAgent;
      const initiallyDisabled = Object.keys(agent.getTools());

      agent.setState({ enabled: true });
      const enabledTools = agent.getTools();
      const prototypeKeyToolsAreOwn = ["__proto__", "constructor", "toString"]
        .every((name) => Object.hasOwn(enabledTools, name));
      const objectPrototypeIsIntact = Object.getPrototypeOf(enabledTools) === Object.prototype;
      const inspect = enabledTools.inspect as {
        inputSchema?: {
          safeParse(value: unknown): { success: boolean };
        };
        outputSchema?: {
          safeParse(value: unknown): { success: boolean };
        };
        execute?: (input: { document: string }, options: unknown) => unknown;
      } | undefined;
      if (!inspect?.inputSchema || !inspect.outputSchema || !inspect.execute) {
        throw new Error("rendered inspect tool lost a schema or execute function");
      }

      const valid = inspect.inputSchema.safeParse({ document: "agent-jsx" }).success;
      const invalid = inspect.inputSchema.safeParse({ document: "" }).success;
      const result = await inspect.execute(
        { document: "agent-jsx" },
        { toolCallId: "compat-inspect", messages: [] },
      );
      const structuredResultMatchesSchema = inspect.outputSchema.safeParse(result).success;

      agent.setState({ enabled: false });
      const disabledAgain = Object.keys(agent.getTools());
      return {
        initiallyDisabled,
        enabledKeys: Object.keys(enabledTools),
        prototypeKeyToolsAreOwn,
        objectPrototypeIsIntact,
        valid,
        invalid,
        result,
        structuredResultMatchesSchema,
        disabledAgain,
      };
    });

    expect(observed.initiallyDisabled).toEqual([]);
    expect(observed.enabledKeys).toEqual([
      "inspect",
      "__proto__",
      "constructor",
      "toString",
    ]);
    expect(observed.prototypeKeyToolsAreOwn).toBe(true);
    expect(observed.objectPrototypeIsIntact).toBe(true);
    expect(observed.valid).toBe(true);
    expect(observed.invalid).toBe(false);
    expect(observed.result).toEqual({ enabled: true, length: 9 });
    expect(observed.structuredResultMatchesSchema).toBe(true);
    expect(observed.disabledAgain).toEqual([]);
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

  it("keeps the live authored prompt when Agent Skills install Session context", async () => {
    const trace = await runInDurableObject(await skillPrompt(), async (instance) => {
      const agent = instance as unknown as ThinkAgent & { getModel: () => LanguageModel };
      agent.setState({ revision: "live" });
      agent.getModel = skillPromptModel;
      return await agent.runTurnWithTrace("Review this evidence");
    });

    expect(trace.text).toBe("authored prompt and skill catalog composed");
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

  it("passes native agentTool input into a class child's rendered props", async () => {
    const parent = await classCoordinator();
    await runInDurableObject(parent, (instance) => {
      const childPrototype = ClassWorkerDurable.prototype as unknown as {
        getModel: () => LanguageModel;
      };
      childPrototype.getModel = classChildModel;
    });

    await runInDurableObject(parent, async (instance) => {
      const agent = instance as unknown as ThinkAgent & {
        getModel: () => LanguageModel;
        runTurn(options: { input: string; mode: "wait" }): Promise<unknown>;
      };
      agent.getModel = classParentToolCallingModel;
      await agent.runTurn({ input: "delegate to the class worker", mode: "wait" });
    });

    const child = await getSubAgentByName(
      parent as never,
      ClassWorkerDurable as never,
      classToolRunId,
    ) as never as { getSystemPrompt(): Promise<string> };
    const prompt = await child.getSystemPrompt();

    expect(prompt).toContain(modelSuppliedClassQuery);
    expect(prompt).not.toContain("compile-time sample query");
  });
});
