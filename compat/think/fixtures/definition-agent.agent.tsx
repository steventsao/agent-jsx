import { z } from "zod";
import {
  Agent,
  compileAgentClass,
  type AgentSkillSource,
} from "../../../src/agent-class.tsx";

const reviewSkill = {
  id: "review",
  fingerprint: "review-v1",
  async list() {
    return [{ name: "review", description: "Review a document." }];
  },
  async load(name: string) {
    return name === "review"
      ? { name, description: "Review a document.", body: "Check the evidence." }
      : null;
  },
} satisfies AgentSkillSource;

class DefinitionAgentClass extends Agent<
  { enabled: boolean },
  { document: string }
> {
  static agentName = "definition-agent";
  initialState = { enabled: true };

  render() {
    return this.define({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      description: "Exercises every rendered definition field.",
      prompt: <prompt><msg>{this.props.document}</msg></prompt>,
      tools: this.state.enabled
        ? {
            inspect: {
              description: "Inspect one document.",
              inputSchema: z.object({ document: z.string() }),
              execute: ({ document }: { document: string }) => ({ length: document.length }),
            },
          }
        : {},
      skills: [reviewSkill],
      mcpServers: {
        docs: {
          url: "https://mcp.example.com/docs",
          transport: "streamable-http",
        },
      },
    });
  }
}

export const DefinitionAgent = compileAgentClass(DefinitionAgentClass);
export default DefinitionAgentClass;
