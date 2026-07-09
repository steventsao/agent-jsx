/**
 * PHASE 3 — close the flue <tool> gap.
 *
 * The flue emit was already the think-shape (instructions = getSystemPrompt,
 * subagents = the child→agentTool roster, model = getModel) EXCEPT the component's
 * <tool> records were skipped ("No static tools" comment). Now a ROOT agent's
 * STATIC <tool> records emit as `tools: [defineTool({ name, description, run })]`
 * on the defineAgent config — the flue analogue of think mode's getTools()[name]
 * = tool(...). Decision (docs/think-target.md): description-only pass-through, no
 * zod→valibot converter (the <tool> intrinsic carries no input schema, and
 * defineTool.input is optional).
 *
 * Zero-churn guardrail: a component with NO static <tool> (uptime — its
 * page-oncall is state-gated/dynamic) is byte-identical; child profiles
 * (emitFlueChild) are unchanged (they stay task-delegation targets).
 */

import { describe, expect, it } from "bun:test";
import { emitFlue, flueProfileExportName } from "../src/compile/emit-flue.ts";
import { analyzeAgent } from "../src/compile/graph.ts";
import { Notetaker } from "../examples/think/notetaker.tsx";
import { UptimeAgent } from "../examples/uptime-agent.tsx";

const MODEL = "openrouter/google/gemini-3.1-flash-lite-preview";

const notetakerFlue = () =>
  emitFlue({
    spec: Notetaker.spec,
    model: MODEL,
    componentName: "Notetaker",
    componentImport: "../agents/notetaker.tsx",
    analysis: analyzeAgent({ spec: Notetaker.spec, exportName: "Notetaker", importPath: "../agents/notetaker.tsx" }),
    childProfiles: [
      { importPath: "./researcher.flue.ts", profileExportName: flueProfileExportName("researcher") },
    ],
    runtimeImport: "./runtime",
  });

describe("emitFlue — static <tool> → tools: [defineTool(...)]", () => {
  it("imports defineTool and emits the component's static tool", () => {
    const flue = notetakerFlue();
    expect(flue).toContain('import { defineAgent, defineTool } from "@flue/runtime";');
    expect(flue).toContain("tools: [");
    expect(flue).toContain("defineTool({");
    expect(flue).toContain('name: "saveNote",');
    expect(flue).toContain('description: "Save a note to the notebook.",');
  });

  it("still emits the child boundary as a native subagents roster (unchanged)", () => {
    const flue = notetakerFlue();
    expect(flue).toContain('import { researcherProfile } from "./researcher.flue.ts";');
    expect(flue).toContain("subagents: [researcherProfile]");
  });

  it("the defineTool run re-renders to invoke the freshest <tool> closure", () => {
    const flue = notetakerFlue();
    // The run body re-evaluates the component and dispatches the fresh tool record
    // (closures never serialize) — the same discipline as spawnPlan.
    expect(flue).toContain("Notetaker.spec.impl(");
    expect(flue).toContain('.find((r) => r.kind === "tool" && r.name === "saveNote")');
  });
});

describe("emitFlue — zero-churn when there is no static tool", () => {
  it("uptime (state-gated page-oncall only) emits NO tools block or defineTool", () => {
    const flue = emitFlue({
      spec: UptimeAgent.spec,
      model: MODEL,
      componentName: "UptimeAgent",
      componentImport: "../agents/uptime-agent.tsx",
      analysis: analyzeAgent({ spec: UptimeAgent.spec, exportName: "UptimeAgent", importPath: "../agents/uptime-agent.tsx" }),
      childProfiles: [
        { importPath: "./investigator.flue.ts", profileExportName: flueProfileExportName("investigator") },
      ],
      runtimeImport: "./runtime",
    });
    expect(flue).not.toContain("defineTool");
    expect(flue).not.toContain("tools: [");
    // the existing shape is preserved
    expect(flue).toContain("subagents: [investigatorProfile]");
    expect(flue).toContain("No static tools");
  });
});
