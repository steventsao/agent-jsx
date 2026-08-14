/**
 * Emit the compiler-owned companions for the parse-pm example's authored
 * function components (./*.agent.tsx). The companions are checked in; rerun
 * this after editing an authored file's public surface.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../src/compile/emit-agent-module.ts";

const output = new URL("./generated/", import.meta.url);
mkdirSync(output, { recursive: true });

writeFileSync(
  new URL("region-extractor.compiled.tsx", output),
  emitAgentModule({
    sourceImport: "../region-extractor.agent.tsx",
    exportName: "RegionExtractor",
    runtimeImport: "../../../src/agent-component.tsx",
    mode: "function",
  }),
);

console.log("generated 1 parse-pm boundary companion");
