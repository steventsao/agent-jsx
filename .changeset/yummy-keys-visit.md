---
"@steventsao/agent-jsx": minor
---

Replace class `model`, `description`, `displayName`, `getPrompt`, `getTools`, `getSkills`, and UI-style `render` authoring with synchronous `render() { return this.define(...) }`, covering model, metadata, prompt, tools, skills, MCP servers, and native child input/output schemas. Publish the Cloudflare compiler entrypoint that lowers the complete definition to model-driven Agents.
