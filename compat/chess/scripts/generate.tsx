import { mkdirSync } from "node:fs";
import { copyAgentComponent, emitRuntimeFiles } from "../../../src/compile/runtime-files.ts";

const src = new URL("../src/", import.meta.url);
const agents = new URL("./agents/", src);
const runtime = new URL("./generated/runtime/", src);

mkdirSync(agents, { recursive: true });
emitRuntimeFiles(runtime.pathname);

for (const file of ["board.tsx", "players.tsx", "match.tsx"]) {
  copyAgentComponent(
    new URL(`../../../examples/chess/${file}`, import.meta.url),
    new URL(file, agents).pathname,
    "../generated/runtime",
    file === "board.tsx"
      ? { 'import type { ReactNode } from "react";\n': "", ReactNode: "unknown" }
      : {},
  );
}

console.log("generated react-free chess agents + runtime");
