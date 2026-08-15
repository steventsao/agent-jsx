/** Generate the flue 2.0 function-agent module + the react-free runtime set. */
import { mkdirSync, writeFileSync } from "node:fs";
import { emitFlue2 } from "../../../src/compile/emit-flue2.ts";
import { copyAgentComponent, emitRuntimeFiles } from "../../../src/compile/runtime-files.ts";

const out = new URL("../src/generated/", import.meta.url);
mkdirSync(out, { recursive: true });

emitRuntimeFiles(`${out.pathname}runtime`);
copyAgentComponent(
  new URL("../../../examples/flue2/oncall.agent.tsx", import.meta.url),
  `${out.pathname}oncall.agent.tsx`,
  "./runtime",
);
writeFileSync(
  new URL("./oncall.flue2.ts", out),
  emitFlue2({
    spec: { agentName: "oncall" },
    sourceImport: "./oncall.agent.tsx",
    exportName: "OncallAgent",
    runtimeImport: "./runtime/compile",
  }),
);
console.log("generated src/generated/oncall.flue2.ts");
