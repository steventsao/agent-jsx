/**
 * The REACT-FREE runtime file set that a compiled artifact carries so it is
 * self-contained (no dependency back into agent-jsx's `src/`).
 *
 * `emitCloudflare`/`emitFlue` copy these to `emitRuntimeTo` when asked. The
 * set is exactly the closure a generated module needs at runtime:
 *   - `tree.ts`            — collectInfra / collectPrompt (no react-reconciler)
 *   - `store.ts`           — createStore / withStaticEval / useAgentState (read)
 *   - `prompt.ts`          — renderPrompt (priompt-lite)
 *   - `types.ts`           — InfraRecord & friends (react import is type-only)
 *   - `agent-component.tsx`— agentComponent() (jsx only; react core, no DOM)
 *   - `workflow-executor.ts`— runReactiveWorkflow (v0.5 flue state→render loop)
 *   - `compile/evaluate.ts`— the ~70-line element walker
 *
 * The layout under `emitRuntimeTo` mirrors `src/` (evaluate.ts stays under
 * `compile/`) so each file's OWN relative imports (`../store.ts`, `./types.ts`)
 * resolve identically in the copy and in-tree — no import rewriting needed.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** relative-to-this-module source path → dest path under the runtime dir. */
const RUNTIME_FILES: ReadonlyArray<readonly [src: string, dest: string]> = [
  ["../tree.ts", "tree.ts"],
  ["../store.ts", "store.ts"],
  ["../prompt.ts", "prompt.ts"],
  ["../types.ts", "types.ts"],
  ["../intrinsics.d.ts", "intrinsics.d.ts"],
  ["../agent-component.tsx", "agent-component.tsx"],
  ["../workflow-executor.ts", "workflow-executor.ts"],
  ["./evaluate.ts", "compile/evaluate.ts"],
  // the react-free JSX runtime: compiled packages set jsxImportSource to a
  // package-imports alias resolving here, so component .tsx never needs react
  ["../jsx-data-runtime.ts", "jsx-runtime.ts"],
  ["../jsx-data-runtime.ts", "jsx-dev-runtime.ts"],
];

/** Copy the react-free runtime set into `destDir` (an absolute filesystem path). */
export function emitRuntimeFiles(destDir: string): void {
  mkdirSync(`${destDir}/compile`, { recursive: true });
  for (const [src, dest] of RUNTIME_FILES) {
    if (dest === "agent-component.tsx") {
      const source = readFileSync(new URL(src, import.meta.url), "utf8")
        .replace(`import type { ReactNode } from "react";\n`, "")
        .replaceAll("ReactNode", "unknown");
      writeFileSync(new URL(`file://${destDir}/${dest}`), source);
    } else {
      cpSync(new URL(src, import.meta.url), new URL(`file://${destDir}/${dest}`));
    }
  }
}

/**
 * Copy a human-authored agent component file into a compat package, rewriting
 * its `../src/...` imports onto the emitted runtime set. The source authors
 * against agent-jsx's dev modules (`state.ts` with the react hook,
 * `agent-component.tsx`); the compiled copy must resolve against the react-free
 * runtime instead — `state.ts` → `store.ts` (the read-only useAgentState).
 *
 * @param runtimeBase relative import base FROM the agent file to the runtime
 *   dir, e.g. "../generated/runtime".
 */
export function copyAgentComponent(
  srcUrl: URL,
  destPath: string,
  runtimeBase: string,
  extraRewrites: Record<string, string> = {}
): void {
  const source = readFileSync(srcUrl, "utf8");
  // longest-first: "../../src/..." must rewrite before "../src/..." or the
  // shorter pattern matches inside the longer one and mangles the path.
  const rewritten = source
    .replaceAll("../../src/state.ts", `${runtimeBase}/store.ts`)
    .replaceAll("../../src/store.ts", `${runtimeBase}/store.ts`)
    .replaceAll("../../src/agent-component.tsx", `${runtimeBase}/agent-component.tsx`)
    .replaceAll("../src/state.ts", `${runtimeBase}/store.ts`)
    .replaceAll("../src/store.ts", `${runtimeBase}/store.ts`)
    .replaceAll("../src/agent-component.tsx", `${runtimeBase}/agent-component.tsx`);
  const finalText = Object.entries(extraRewrites).reduce(
    (acc, [from, to]) => acc.replaceAll(from, to),
    rewritten
  );
  writeFileSync(destPath, finalText);
}
