import { z } from "zod";
import { Agent, compileAgentClass } from "../../../src/agent-class.tsx";

class DynamicToolsAgentClass extends Agent<{ enabled: boolean }> {
  static agentName = "dynamic-tools";
  initialState = { enabled: false };

  render() {
    const inspect = {
      description: "Inspect one document.",
      inputSchema: z.object({ document: z.string().min(1) }),
      outputSchema: z.object({
        enabled: z.boolean(),
        length: z.number().int().nonnegative(),
      }),
      execute: ({ document }: { document: string }) => ({
        enabled: this.state.enabled,
        length: document.length,
      }),
    };
    const prototypeSafe = {
      description: "Prove prototype-key tool names survive.",
      execute: () => ({ ok: true }),
    };
    return this.define({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      prompt: "Exercise a render-declared tool only while it is enabled.",
      tools: this.state.enabled
        ? Object.fromEntries([
            ["inspect", inspect],
            ["__proto__", prototypeSafe],
            ["constructor", prototypeSafe],
            ["toString", prototypeSafe],
          ])
        : {},
    });
  }
}

export const DynamicToolsAgent = compileAgentClass(DynamicToolsAgentClass);
export default DynamicToolsAgentClass;
