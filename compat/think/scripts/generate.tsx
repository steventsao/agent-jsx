/**
 * Compile the tool-slot acceptance composition into this package in THINK mode:
 *   src/agents/     — coordinator.tsx + worker.tsx, copied (imports rewritten
 *                     onto the react-free runtime);
 *   src/generated/  — emitThink classes (CoordinatorDurable/ToolWorkerDurable),
 *                     the runtime file set, the wrangler fragment.
 *
 * The composition is the verbatim slot binding `onCall -> Worker`, so the emitted
 * CoordinatorDurable.getTools() returns { onCall: agentTool(ToolWorkerDurable, …) }.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { emitThink } from "../../../src/compile/emit-think.ts";
import { analyzeAgent } from "../../../src/compile/graph.ts";
import { discoverToolSlots } from "../../../src/compile/slots.ts";
import { copyAgentComponent } from "../../../src/compile/runtime-files.ts";
import { Coordinator } from "../../../examples/tool-slot/coordinator.tsx";
import { Worker } from "../../../examples/tool-slot/worker.tsx";
import { DefinitionAgent } from "../fixtures/definition-agent.agent.tsx";
import { DynamicToolsAgent } from "../fixtures/dynamic-tools.agent.tsx";
import {
  McpBareTokenAgent,
  McpPrefixedTokenAgent,
} from "../fixtures/mcp-query.agent.tsx";
import { SkillPromptAgent } from "../fixtures/skill-prompt.agent.tsx";
import {
  ClassCoordinator,
  ClassWorker,
} from "../fixtures/class-agent-tool.agent.tsx";

const here = (p: string) => new URL(`../${p}`, import.meta.url);
mkdirSync(here("src/agents").pathname, { recursive: true });
mkdirSync(here("src/generated").pathname, { recursive: true });

copyAgentComponent(
  new URL("../../../examples/tool-slot/coordinator.tsx", import.meta.url),
  here("src/agents/coordinator.tsx").pathname,
  "../generated/runtime"
);
copyAgentComponent(
  new URL("../fixtures/class-agent-tool.agent.tsx", import.meta.url),
  here("src/agents/class-agent-tool.agent.tsx").pathname,
  "../generated/runtime",
  {
    "../../generated/runtime/agent-class.tsx": "../generated/runtime/agent-class.tsx",
    "../../generated/runtime/agent-component.tsx": "../generated/runtime/agent-component.tsx",
  },
);
copyAgentComponent(
  new URL("../fixtures/definition-agent.agent.tsx", import.meta.url),
  here("src/agents/definition-agent.agent.tsx").pathname,
  "../generated/runtime",
  {
    "../../generated/runtime/agent-class.tsx": "../generated/runtime/agent-class.tsx",
  },
);
copyAgentComponent(
  new URL("../fixtures/dynamic-tools.agent.tsx", import.meta.url),
  here("src/agents/dynamic-tools.agent.tsx").pathname,
  "../generated/runtime",
  {
    "../../generated/runtime/agent-class.tsx": "../generated/runtime/agent-class.tsx",
  },
);
copyAgentComponent(
  new URL("../fixtures/skill-prompt.agent.tsx", import.meta.url),
  here("src/agents/skill-prompt.agent.tsx").pathname,
  "../generated/runtime",
  {
    "../../generated/runtime/agent-class.tsx": "../generated/runtime/agent-class.tsx",
  },
);
copyAgentComponent(
  new URL("../fixtures/mcp-query.agent.tsx", import.meta.url),
  here("src/agents/mcp-query.agent.tsx").pathname,
  "../generated/runtime",
  {
    "../../generated/runtime/agent-class.tsx": "../generated/runtime/agent-class.tsx",
  },
);
copyAgentComponent(
  new URL("../../../examples/tool-slot/worker.tsx", import.meta.url),
  here("src/agents/worker.tsx").pathname,
  "../generated/runtime"
);

// The verbatim acceptance composition: Coordinator names no child; the slot is
// filled by Worker bound to the onCall prop → getTools()["onCall"].
const composition = (
  <Coordinator name="coord">{(handleCall) => <Worker name="w" onCall={handleCall} />}</Coordinator>
);

const out = emitThink(
  { spec: Coordinator.spec, componentName: "Coordinator", componentImport: "../agents/coordinator.tsx" },
  [{ spec: Worker.spec, exportName: "Worker", importPath: "../agents/worker.tsx" }],
  analyzeAgent({ spec: Coordinator.spec, exportName: "Coordinator", importPath: "../agents/coordinator.tsx" }),
  {
    runtimeImport: "./runtime",
    emitRuntimeTo: here("src/generated/runtime").pathname,
    toolSlots: discoverToolSlots(composition),
  }
);

const definitionOut = emitThink(
  {
    spec: DefinitionAgent.spec,
    componentName: "DefinitionAgent",
    componentImport: "../agents/definition-agent.agent.tsx",
  },
  [],
  analyzeAgent({
    spec: DefinitionAgent.spec,
    exportName: "DefinitionAgent",
    importPath: "../agents/definition-agent.agent.tsx",
    samples: [{ props: { document: "sample" }, state: DefinitionAgent.spec.initialState }],
  }),
  {
    runtimeImport: "./runtime",
    mcpResolver: {
      importPath: "../mcp-runtime.ts",
      exportName: "resolveMcpServer",
    },
  },
);

// Kept separate from the full-definition fixture so workerd can exercise raw
// tools without attempting an MCP connection during Durable Object startup.
const dynamicToolsOut = emitThink(
  {
    spec: DynamicToolsAgent.spec,
    componentName: "DynamicToolsAgent",
    componentImport: "../agents/dynamic-tools.agent.tsx",
  },
  [],
  analyzeAgent({
    spec: DynamicToolsAgent.spec,
    exportName: "DynamicToolsAgent",
    importPath: "../agents/dynamic-tools.agent.tsx",
    samples: [
      { state: { enabled: false } },
      { state: { enabled: true } },
    ],
  }),
  { runtimeImport: "./runtime" },
);

const classAgentToolOut = emitThink(
  {
    spec: ClassCoordinator.spec,
    componentName: "ClassCoordinator",
    componentImport: "../agents/class-agent-tool.agent.tsx",
  },
  [{
    spec: ClassWorker.spec,
    exportName: "ClassWorker",
    importPath: "../agents/class-agent-tool.agent.tsx",
    sampleProps: { query: "compile-time sample query" },
  }],
  analyzeAgent({
    spec: ClassCoordinator.spec,
    exportName: "ClassCoordinator",
    importPath: "../agents/class-agent-tool.agent.tsx",
  }),
  { runtimeImport: "./runtime" },
);

const skillPromptOut = emitThink(
  {
    spec: SkillPromptAgent.spec,
    componentName: "SkillPromptAgent",
    componentImport: "../agents/skill-prompt.agent.tsx",
  },
  [],
  analyzeAgent({
    spec: SkillPromptAgent.spec,
    exportName: "SkillPromptAgent",
    importPath: "../agents/skill-prompt.agent.tsx",
  }),
  { runtimeImport: "./runtime" },
);

const emitMcpQueryAgent = (
  component: typeof McpBareTokenAgent,
  componentName: "McpBareTokenAgent" | "McpPrefixedTokenAgent",
) => emitThink(
  {
    spec: component.spec,
    componentName,
    componentImport: "../agents/mcp-query.agent.tsx",
  },
  [],
  analyzeAgent({
    spec: component.spec,
    exportName: componentName,
    importPath: "../agents/mcp-query.agent.tsx",
  }),
  {
    runtimeImport: "./runtime",
    mcpResolver: {
      importPath: "../mcp-runtime.ts",
      exportName: "resolveMcpServer",
    },
  },
);
const mcpBareTokenOut = emitMcpQueryAgent(McpBareTokenAgent, "McpBareTokenAgent");
const mcpPrefixedTokenOut = emitMcpQueryAgent(
  McpPrefixedTokenAgent,
  "McpPrefixedTokenAgent",
);

writeFileSync(here("src/generated/think.cloudflare.ts").pathname, out.agents);
writeFileSync(here("src/generated/think.wrangler.jsonc").pathname, out.wrangler);
writeFileSync(here("src/generated/definition.cloudflare.ts").pathname, definitionOut.agents);
writeFileSync(here("src/generated/dynamic-tools.cloudflare.ts").pathname, dynamicToolsOut.agents);
writeFileSync(here("src/generated/class-agent-tool.cloudflare.ts").pathname, classAgentToolOut.agents);
writeFileSync(here("src/generated/skill-prompt.cloudflare.ts").pathname, skillPromptOut.agents);
writeFileSync(here("src/generated/mcp-bare-token.cloudflare.ts").pathname, mcpBareTokenOut.agents);
writeFileSync(here("src/generated/mcp-prefixed-token.cloudflare.ts").pathname, mcpPrefixedTokenOut.agents);
console.log("generated: Think tool-slot + full-definition + dynamic raw-tool + class agentTool + skill prompt + MCP validation compatibility modules + runtime/");
