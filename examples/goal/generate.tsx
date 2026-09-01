/**
 * Emit the compiler-owned companions for the goal example's authored function
 * components (./*.agent.tsx). The companions are checked in; rerun this after
 * editing an authored file's public surface.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../src/compile/emit-agent-module.ts";

const output = new URL("./generated/", import.meta.url);
mkdirSync(output, { recursive: true });

writeFileSync(
  new URL("phase-worker.compiled.tsx", output),
  emitAgentModule({
    sourceImport: "../phase-worker.agent.tsx",
    exportName: "PhaseWorker",
    runtimeImport: "../../../src/agent-component.tsx",
    mode: "function",
  }),
);

console.log("generated 1 goal boundary companion");
