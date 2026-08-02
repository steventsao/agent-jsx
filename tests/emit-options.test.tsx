/**
 * Emitter OPTIONS — compile-time knobs that change the generated artifact:
 *
 *   - emitCloudflare `intervalScale`: authored ticks → wall-clock seconds, as
 *     the emitted INTERVAL_SCALE constant every schedule/sensor cadence is
 *     multiplied by at reconcile time;
 *   - emitThink `promptBudget`: the emitted PROMPT_BUDGET constant the
 *     generated getSystemPrompt passes to renderPromptOrFallback per turn;
 *   - emitFlue/emitFlueChild `promptBudget`: applied AT EMIT TIME — the resting
 *     instructions are rendered under the budget, so a tight budget drops
 *     low-priority prompt blocks from the generated module entirely;
 *   - `emitRuntimeTo` on all three emitters: copies the react-free runtime
 *     file set to disk. The import SPECIFIER is governed by `runtimeImport`
 *     alone — emitRuntimeTo does not rewrite it;
 *   - emitThink `modelResolver` with NO authored model anywhere: the resolver
 *     import is gated on hasAnyModel, so nothing references it (the modeled
 *     happy path is covered in emit-think.test.tsx).
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentComponent, type AnyAgentSpec } from "../src/agent-component.tsx";
import { analyzeAgent } from "../src/compile/graph.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { emitFlue, emitFlueChild } from "../src/compile/emit-flue.ts";
import { emitThink } from "../src/compile/emit-think.ts";

const moduleOf = (component: { spec: AnyAgentSpec }, exportName: string) => ({
  spec: component.spec,
  exportName,
  importPath: `./${exportName.toLowerCase()}.tsx`,
});

const Ticking = agentComponent({
  agentName: "ticking",
  initialState: {},
  impl: () => (
    <>
      <schedule name="poll" every={5} onFire={() => {}} />
      <prompt>
        <sys p={10}>Poll on a cadence.</sys>
      </prompt>
    </>
  ),
});

// A two-priority prompt: the p=10 core rule is 3 tokens (chars/4); the p=1
// detail block is ~90 tokens, so a budget between the two costs keeps ONLY
// the core rule, and a generous budget keeps both.
const DETAIL = `Detail block: ${"lorem ipsum ".repeat(30)}`.trim();

const Prioritized = agentComponent({
  agentName: "prioritized",
  model: "test/model",
  initialState: {},
  impl: () => (
    <prompt>
      <sys p={10}>Core rule.</sys>
      <msg p={1}>{DETAIL}</msg>
    </prompt>
  ),
});

const prioritizedFlue = (promptBudget?: number) =>
  emitFlue({
    spec: Prioritized.spec,
    componentName: "Prioritized",
    componentImport: "./prioritized.tsx",
    analysis: analyzeAgent(moduleOf(Prioritized, "Prioritized")),
    promptBudget,
    runtimeImport: "./runtime",
  });

const withRuntimeDir = (fn: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-jsx-runtime-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const RUNTIME_FILES = ["tree.ts", "store.ts", "prompt.ts", "jsx-runtime.ts", "compile/evaluate.ts"];

describe("emitCloudflare — intervalScale", () => {
  const root = { spec: Ticking.spec, componentName: "Ticking", componentImport: "./ticking.tsx" };
  const analysis = () => analyzeAgent(moduleOf(Ticking, "Ticking"));

  it("defaults to 1 (authored ticks are already seconds)", () => {
    const out = emitCloudflare(root, [], analysis(), { runtimeImport: "./runtime" });
    expect(out.agents).toContain("const INTERVAL_SCALE = 1;");
  });

  it("scales every schedule/sensor cadence by the emitted constant", () => {
    const out = emitCloudflare(root, [], analysis(), { runtimeImport: "./runtime", intervalScale: 30 });
    expect(out.agents).toContain("const INTERVAL_SCALE = 30;");
    expect(out.agents).toContain("const every = Number(rec.config.every ?? rec.config.interval) * INTERVAL_SCALE;");
    expect(out.agents).toContain("await this.schedule(every, \"onAgentEvent\", { key, rearm: every }, { idempotent: true });");
  });
});

describe("emitThink — promptBudget", () => {
  const think = (promptBudget?: number) =>
    emitThink(
      { spec: Prioritized.spec, componentName: "Prioritized", componentImport: "./prioritized.tsx" },
      [],
      analyzeAgent(moduleOf(Prioritized, "Prioritized")),
      { runtimeImport: "./runtime", promptBudget }
    ).agents;

  it("defaults to 400", () => {
    expect(think()).toContain("const PROMPT_BUDGET = 400;");
  });

  it("emits the budget the generated getSystemPrompt renders under", () => {
    const agents = think(123);
    expect(agents).toContain("const PROMPT_BUDGET = 123;");
    expect(agents).toContain("renderPromptOrFallback(blocks, PROMPT_BUDGET, () => this.imperativePrompt(this.state as S))");
  });
});

describe("emitFlue — promptBudget is applied at emit time", () => {
  it("a tight budget drops low-priority blocks from the emitted instructions", () => {
    const flue = prioritizedFlue(50);
    expect(flue).toContain(`instructions: "[system] Core rule.",`);
    expect(flue).not.toContain("lorem ipsum");
  });

  it("the default budget keeps every block", () => {
    const flue = prioritizedFlue();
    expect(flue).toContain("[system] Core rule.");
    expect(flue).toContain("lorem ipsum");
  });

  it("emitFlueChild takes the same budget as its positional parameter", () => {
    const child = { spec: Prioritized.spec, exportName: "Prioritized", importPath: "./prioritized.tsx" };
    const tight = emitFlueChild(child, 50, { runtimeImport: "./runtime" });
    expect(tight).toContain(`instructions: "[system] Core rule.",`);
    expect(tight).not.toContain("lorem ipsum");
    const roomy = emitFlueChild(child, 400, { runtimeImport: "./runtime" });
    expect(roomy).toContain("lorem ipsum");
  });
});

describe("emitRuntimeTo — copies the react-free runtime set", () => {
  it("emitCloudflare", () => {
    withRuntimeDir((dir) => {
      const out = emitCloudflare(
        { spec: Ticking.spec, componentName: "Ticking", componentImport: "./ticking.tsx" },
        [],
        analyzeAgent(moduleOf(Ticking, "Ticking")),
        { runtimeImport: "./runtime", emitRuntimeTo: dir }
      );
      for (const file of RUNTIME_FILES) expect(existsSync(join(dir, file))).toBe(true);
      expect(out.agents).toContain(`import { evaluateTree } from "./runtime/compile/evaluate.ts";`);
    });
  });

  it("emitFlue", () => {
    withRuntimeDir((dir) => {
      const out = emitFlue({
        spec: Prioritized.spec,
        componentName: "Prioritized",
        componentImport: "./prioritized.tsx",
        analysis: analyzeAgent(moduleOf(Prioritized, "Prioritized")),
        runtimeImport: "./runtime",
        emitRuntimeTo: dir,
      });
      for (const file of RUNTIME_FILES) expect(existsSync(join(dir, file))).toBe(true);
      expect(out).toContain(`import { evaluateTree } from "./runtime/compile/evaluate.ts";`);
    });
  });

  it("emitThink", () => {
    withRuntimeDir((dir) => {
      const { agents } = emitThink(
        { spec: Prioritized.spec, componentName: "Prioritized", componentImport: "./prioritized.tsx" },
        [],
        analyzeAgent(moduleOf(Prioritized, "Prioritized")),
        { runtimeImport: "./runtime", emitRuntimeTo: dir }
      );
      for (const file of RUNTIME_FILES) expect(existsSync(join(dir, file))).toBe(true);
      expect(agents).toContain(`import { evaluateTree } from "./runtime/compile/evaluate.ts";`);
    });
  });

  it("the import specifier is governed by runtimeImport, NOT emitRuntimeTo", () => {
    withRuntimeDir((dir) => {
      const out = emitFlue({
        spec: Prioritized.spec,
        componentName: "Prioritized",
        componentImport: "./prioritized.tsx",
        analysis: analyzeAgent(moduleOf(Prioritized, "Prioritized")),
        emitRuntimeTo: dir,
      });
      // Files land on disk, but without runtimeImport the specifier stays the default.
      for (const file of RUNTIME_FILES) expect(existsSync(join(dir, file))).toBe(true);
      expect(out).toContain(`import { evaluateTree } from "../../src/compile/evaluate.ts";`);
      expect(out).not.toContain("./runtime/");
    });
  });
});

describe("emitThink — modelResolver with no authored model anywhere", () => {
  it("emits no resolver import and no getModel override", () => {
    const { agents } = emitThink(
      { spec: Ticking.spec, componentName: "Ticking", componentImport: "./ticking.tsx" },
      [],
      analyzeAgent(moduleOf(Ticking, "Ticking")),
      {
        runtimeImport: "./runtime",
        modelResolver: { importPath: "./model-runtime.ts", exportName: "resolveDeploymentModel" },
      }
    );
    expect(agents).not.toContain("resolveDeploymentModel");
    expect(agents).not.toContain("model-runtime");
    expect(agents).not.toContain("getModel() {");
  });
});
