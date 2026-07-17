import { mkdirSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../src/compile/emit-agent-module.ts";
import { emitThink } from "../../src/compile/emit-think.ts";
import { discoverAgents, type AgentModule } from "../../src/compile/graph.ts";
import {
  emitFlue,
  emitFlueChild,
  emitFlueWorkflow,
  flueProfileExportName,
} from "../../src/compile/emit-flue.ts";
import { TradingDesk, initialRiskState } from "./composition.tsx";
import { TraderAgent } from "./agents.tsx";

const root: AgentModule = {
  spec: TradingDesk.spec,
  exportName: "TradingDesk",
  importPath: "../composition.tsx",
  // Two samples: flat/no-quotes (no traders) and an active desk with quotes so
  // analysis discovers the per-symbol trader boundary.
  samples: [
    { state: initialRiskState },
    {
      state: {
        ...initialRiskState,
        prices: { AAPL: 100, MSFT: 50 },
        round: 1,
        lastTick: 1,
      },
    },
  ],
};
const registry: AgentModule[] = [
  { spec: TraderAgent.spec, exportName: "TraderAgent", importPath: "../agents.tsx" },
];
const graph = discoverAgents(root, registry);
const rootNode = graph[0]!;
const childProfiles = rootNode.directChildren.map((kind) => ({
  importPath: `./${kind}.flue.ts`,
  profileExportName: flueProfileExportName(kind),
}));

const output = new URL("./generated/", import.meta.url);
mkdirSync(output, { recursive: true });
const write = (name: string, source: string) => writeFileSync(new URL(name, output), source);

write(
  "risk-manager.compiled.tsx",
  emitAgentModule({
    sourceImport: "../risk-manager-agent.tsx",
    exportName: "RiskManagerAgent",
    runtimeImport: "../../../src/agent-class.tsx",
  }),
);
write(
  "symbol-trader.compiled.tsx",
  emitAgentModule({
    sourceImport: "../trader-agent.tsx",
    exportName: "TraderAgent",
    runtimeImport: "../../../src/agent-class.tsx",
  }),
);

write(
  "risk-manager.flue.ts",
  emitFlue({
    spec: rootNode.spec,
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
    analysis: rootNode.analysis,
    childProfiles,
    runtimeImport: "./runtime",
  }),
);
write(
  "risk-manager.workflow.ts",
  emitFlueWorkflow({
    spec: rootNode.spec,
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
    agentModuleImport: "./risk-manager.flue.ts",
    runtimeImport: "./runtime",
  }),
);
for (const child of graph.slice(1)) {
  write(
    `${child.spec.agentName}.flue.ts`,
    emitFlueChild(
      {
        spec: child.spec,
        exportName: child.exportName,
        importPath: child.importPath,
        sampleProps: child.samples?.[0]?.props,
      },
      400,
      { runtimeImport: "./runtime", analysis: child.analysis },
    ),
  );
}

const think = emitThink(
  {
    spec: rootNode.spec,
    componentName: rootNode.exportName,
    componentImport: rootNode.importPath,
  },
  graph.slice(1).map((child) => ({
    spec: child.spec,
    exportName: child.exportName,
    importPath: child.importPath,
    sampleProps: child.samples?.[0]?.props,
  })),
  rootNode.analysis,
  { runtimeImport: "./runtime" },
);
write("risk-manager.think.ts", think.agents);
write("risk-manager.think.wrangler.jsonc", think.wrangler);

console.log(
  `generated 2 agent boundary companions + ${graph.length + 1} trading Flue modules + Think target`,
);
