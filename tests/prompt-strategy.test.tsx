/**
 * Part B contract: the <prompt> tag is OPT-IN. The declarative tree wins when
 * it yields blocks (priompt priorities/budget); otherwise the imperative
 * `spec.getPrompt` seam is the fallback; otherwise the context layer is empty.
 *
 * These exercise the shared pure helper (`renderPromptOrFallback`) AND the
 * end-to-end derivation off a real agentComponent spec — the same two inputs
 * the cloudflare `promptFor` and the flue instruction derivation feed it.
 */

import { describe, expect, it } from "bun:test";
import { agentComponent } from "../src/agent-component.tsx";
import { renderPromptOrFallback } from "../src/prompt.ts";
import { collectPrompt } from "../src/tree.ts";
import { evaluateComponent } from "../src/compile/evaluate.ts";
import { createStore } from "../src/state.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { emitFlue } from "../src/compile/emit-flue.ts";

const NO_ANALYSIS = { static: [], dynamic: [] };

interface CountState extends Record<string, unknown> {
  n: number;
}

// A component with NO <prompt> — only an imperative getPrompt seam.
const NoPromptAgent = agentComponent<Record<string, never>, CountState>({
  agentName: "no-prompt",
  initialState: { n: 3 },
  getPrompt: (state) => `imperative prompt at n=${state.n}`,
  impl: ({ store }) => (
    <>
      <tool name="noop" description="does nothing" run={() => "ok"} />
    </>
  ),
});

// A component with BOTH a declarative <prompt> AND a getPrompt: tree must win.
const BothAgent = agentComponent<Record<string, never>, CountState>({
  agentName: "both",
  initialState: { n: 7 },
  getPrompt: () => "IMPERATIVE-FALLBACK",
  impl: ({ store }) => (
    <prompt>
      <sys p={10}>DECLARATIVE wins when present.</sys>
    </prompt>
  ),
});

const blocksOf = (spec: typeof NoPromptAgent.spec) =>
  collectPrompt(evaluateComponent(spec.impl, { store: createStore(spec.initialState) } as never));

describe("renderPromptOrFallback (pure)", () => {
  it("uses the fallback when there are no declarative blocks", () => {
    const out = renderPromptOrFallback([], 400, () => "FELL BACK");
    expect(out).toBe("FELL BACK");
  });

  it("renders the declarative blocks and IGNORES the fallback when blocks exist", () => {
    const blocks = blocksOf(BothAgent.spec);
    expect(blocks.length).toBeGreaterThan(0);
    const out = renderPromptOrFallback(blocks, 400, () => "IMPERATIVE-FALLBACK");
    expect(out).toContain("DECLARATIVE");
    expect(out).not.toContain("IMPERATIVE-FALLBACK");
  });
});

describe("getPrompt as the context-window fallback", () => {
  it("a component with no <prompt> yields no blocks, so getPrompt is used", () => {
    const blocks = blocksOf(NoPromptAgent.spec);
    expect(blocks).toHaveLength(0);
    const out = renderPromptOrFallback(blocks, 400, () =>
      NoPromptAgent.spec.getPrompt!(NoPromptAgent.spec.initialState)
    );
    expect(out).toBe("imperative prompt at n=3");
  });

  it("a component with both a <prompt> and getPrompt lets the tree win", () => {
    const blocks = blocksOf(BothAgent.spec);
    const out = renderPromptOrFallback(blocks, 400, () =>
      BothAgent.spec.getPrompt!(BothAgent.spec.initialState)
    );
    expect(out).toContain("DECLARATIVE");
    expect(out).not.toContain("IMPERATIVE-FALLBACK");
  });
});

describe("emitters route the getPrompt fallback (part B)", () => {
  it("cloudflare promptFor uses the strategy helper and routes to spec.getPrompt", () => {
    const out = emitCloudflare(
      { spec: NoPromptAgent.spec, componentName: "NoPromptAgent", componentImport: "./no-prompt.tsx" },
      [],
      NO_ANALYSIS,
      { runtimeImport: "./runtime" }
    );
    expect(out.agents).toContain("renderPromptOrFallback");
    expect(out.agents).toContain("NoPromptAgent.spec.getPrompt?.(state)");
  });

  it("flue instructions fall back to getPrompt when the tree has no <prompt>", () => {
    const parent = emitFlue({
      spec: NoPromptAgent.spec,
      model: "m",
      componentName: "NoPromptAgent",
      componentImport: "./no-prompt.tsx",
      analysis: NO_ANALYSIS,
      runtimeImport: "./runtime",
    });
    expect(parent).toContain(`instructions: "imperative prompt at n=3"`);
  });

  it("flue instructions let the declarative tree win when both are present", () => {
    const parent = emitFlue({
      spec: BothAgent.spec,
      model: "m",
      componentName: "BothAgent",
      componentImport: "./both.tsx",
      analysis: NO_ANALYSIS,
      runtimeImport: "./runtime",
    });
    expect(parent).toContain("DECLARATIVE");
    expect(parent).not.toContain("IMPERATIVE-FALLBACK");
  });
});
