import { Agent } from "../src/agent-class.tsx";
import type { AgentSkillSource } from "../src/types.ts";

const reviewSkill = {
  id: "review",
  fingerprint: "review-v1",
  async list() { return []; },
  async load() { return null; },
} satisfies AgentSkillSource;

class DefinitionAgent extends Agent<Record<string, never>, { topic: string }> {
  static agentName = "definition-type";
  initialState = {};

  render() {
    return this.define({
      model: "test/model",
      prompt: <prompt><msg>{this.props.topic}</msg></prompt>,
      tools: {
        lookup: { description: "Lookup", execute: () => "ok" },
      },
      skills: [reviewSkill],
      mcpServers: {
        docs: { url: "https://mcp.example.com", transport: "streamable-http" },
      },
    });
  }
}

class UiAgent extends Agent<Record<string, never>> {
  static agentName = "ui-type";
  initialState = {};

  // @ts-expect-error render() declares an agent definition, not UI.
  render() {
    return <div />;
  }
}

interface CallbackProps {
  query: string;
  onResult: (value: string) => void;
}

class CallbackInputAgent extends Agent<Record<string, never>, CallbackProps> {
  static agentName = "callback-input-type";
  initialState = {};

  render() {
    return this.define({
      model: "test/model",
      inputSchema: {
        parse(value: unknown): { query: string } {
          return value as { query: string };
        },
      },
    });
  }
}

void DefinitionAgent;
void UiAgent;
void CallbackInputAgent;
