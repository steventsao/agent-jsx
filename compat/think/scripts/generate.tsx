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

const here = (p: string) => new URL(`../${p}`, import.meta.url);
mkdirSync(here("src/agents").pathname, { recursive: true });
mkdirSync(here("src/generated").pathname, { recursive: true });

copyAgentComponent(
  new URL("../../../examples/tool-slot/coordinator.tsx", import.meta.url),
  here("src/agents/coordinator.tsx").pathname,
  "../generated/runtime"
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

writeFileSync(here("src/generated/think.cloudflare.ts").pathname, out.agents);
writeFileSync(here("src/generated/think.wrangler.jsonc").pathname, out.wrangler);
console.log("generated: src/generated/think.cloudflare.ts (CoordinatorDurable → agentTool(ToolWorkerDurable)) + runtime/");
