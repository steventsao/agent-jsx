/**
 * Generate the react-free parse-pm worker sources — the SAME pipeline as
 * compat/chess-goal/scripts/generate.tsx, pointed at the PM composition:
 *
 *   1. copy the react-free runtime file set (tree/store/goal/evaluate/…);
 *   2. copy the authored agent files with imports rewritten onto that runtime
 *      (goal-provider from examples/goal; ports/fake-provider/region-extractor/
 *      parse-agent/drive from examples/parse-pm — UNCHANGED source, the worker
 *      runs the exact composition the sim demo and root tests run);
 *   3. copy the shared PDF domain primitive + the layout fixture into
 *      src/domain (unpdf resolves from this package's own node_modules).
 *
 * There is no Think target here: the PM's model step is a direct metered
 * provider call (src/model-runtime.ts), and the children are played in-process
 * through their granted capabilities (drive.ts).
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { emitAgentModule } from "../../../src/compile/emit-agent-module.ts";
import { copyAgentComponent, emitRuntimeFiles } from "../../../src/compile/runtime-files.ts";

const src = new URL("../src/", import.meta.url);
const agents = new URL("./agents/", src);
const domain = new URL("./domain/", src);
const runtime = new URL("./generated/runtime/", src);

mkdirSync(agents, { recursive: true });
mkdirSync(domain, { recursive: true });
emitRuntimeFiles(runtime.pathname);

// The shared extraction spec travels with the package; the layout fixture's
// type import is rewritten onto the copied spec.
cpSync(
  new URL("../../../examples/pdf/core/extract.ts", import.meta.url),
  new URL("extract.ts", domain),
);
writeFileSync(
  new URL("regions.ts", domain),
  readFileSync(new URL("../../../fixtures/pdf/regions.ts", import.meta.url), "utf8").replaceAll(
    "../../examples/pdf/core/extract.ts",
    "./extract.ts",
  ),
);

// The goal layer's provider, rewritten onto the runtime set.
copyAgentComponent(
  new URL("../../../examples/goal/goal-provider.tsx", import.meta.url),
  new URL("goal-provider.tsx", agents).pathname,
  "../generated/runtime",
  {
    'import type { ReactNode } from "react";\n': "",
    ReactNode: "unknown",
    "../../src/compile/evaluate.ts": "../generated/runtime/compile/evaluate.ts",
    "../../src/tree.ts": "../generated/runtime/tree.ts",
    "../../src/goal.ts": "../generated/runtime/goal.ts",
  },
);

// The parse-pm composition itself, verbatim from examples/parse-pm.
const PARSE_PM_REWRITES: Record<string, string> = {
  "../pdf/core/extract.ts": "../domain/extract.ts",
  "../../fixtures/pdf/regions.ts": "../domain/regions.ts",
  "../goal/goal-provider.tsx": "./goal-provider.tsx",
  "../../src/compile/evaluate.ts": "../generated/runtime/compile/evaluate.ts",
  "../../src/tree.ts": "../generated/runtime/tree.ts",
  "../../src/prompt.ts": "../generated/runtime/prompt.ts",
  "../../src/types.ts": "../generated/runtime/types.ts",
};
for (const file of [
  "ports.ts",
  "fake-provider.ts",
  "region-extractor.agent.tsx",
  "region-extractor.tsx",
  "parse-agent.tsx",
  "drive.ts",
]) {
  copyAgentComponent(
    new URL(`../../../examples/parse-pm/${file}`, import.meta.url),
    new URL(file, agents).pathname,
    "../generated/runtime",
    PARSE_PM_REWRITES,
  );
}

// Re-emit the compiler-owned function→boundary companion against the copied
// runtime (the barrel at agents/region-extractor.tsx resolves ./generated/).
const generatedAgents = new URL("./generated/", agents);
mkdirSync(generatedAgents, { recursive: true });
writeFileSync(
  new URL("region-extractor.compiled.tsx", generatedAgents),
  emitAgentModule({
    sourceImport: "../region-extractor.agent.tsx",
    exportName: "RegionExtractor",
    runtimeImport: "../../generated/runtime/agent-component.tsx",
    mode: "function",
  }),
);

console.log("generated react-free parse-pm agents + goal runtime + domain spec");
