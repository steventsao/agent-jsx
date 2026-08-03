import { Agent, compileAgentClass } from "../../../src/agent-class.tsx";

class McpBareTokenAgentClass extends Agent<Record<string, never>> {
  static agentName = "mcp-bare-token";
  initialState = {};

  render() {
    return this.define({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      mcpServers: {
        "bare-token": { url: "https://mcp.example.com/bare-token" },
      },
    });
  }
}

class McpPrefixedTokenAgentClass extends Agent<Record<string, never>> {
  static agentName = "mcp-prefixed-token";
  initialState = {};

  render() {
    return this.define({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      mcpServers: {
        "prefixed-token": { url: "https://mcp.example.com/prefixed-token" },
      },
    });
  }
}

export const McpBareTokenAgent = compileAgentClass(McpBareTokenAgentClass);
export const McpPrefixedTokenAgent = compileAgentClass(McpPrefixedTokenAgentClass);
