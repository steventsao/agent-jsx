/**
 * PHASE 3 flue proof: the emitted `tools: [defineTool(...)]` satisfies the REAL
 * @flue/runtime. Importing notetaker.flue.ts + calling initialize() runs flue's
 * own defineTool validator (assertToolDefinition — the oracle); a malformed tool
 * would throw. Then we invoke the emitted run to prove it re-renders the
 * component and dispatches the freshest <tool> closure. Do not weaken these — and
 * the pre-existing flue-compat/workflow assertions stay untouched.
 */

import { describe, expect, it } from "vitest";
import notetakerAgent from "../src/generated/notetaker.flue.ts";

type Cfg = {
  tools?: { name: string; description: string; run: (ctx: unknown) => Promise<unknown> }[];
  subagents?: { name?: string }[];
};

describe("emitted <tool> against real @flue/runtime (defineTool oracle)", () => {
  it("initialize() passes flue's defineTool validation and carries the static tool", async () => {
    const cfg = (await (
      notetakerAgent as { initialize: (ctx: unknown) => Promise<Cfg> }
    ).initialize({})) as Cfg;
    const tool = cfg.tools?.find((t) => t.name === "saveNote");
    expect(tool).toBeTruthy(); // defineTool accepted it (name/description/run valid)
    expect(tool!.description).toBe("Save a note to the notebook.");
    // the child boundary still lands as a native subagents roster entry
    expect(cfg.subagents?.map((s) => s.name)).toContain("researcher");
  });

  it("the emitted defineTool run re-renders and dispatches the component <tool> closure", async () => {
    const cfg = (await (
      notetakerAgent as { initialize: (ctx: unknown) => Promise<Cfg> }
    ).initialize({})) as Cfg;
    const tool = cfg.tools!.find((t) => t.name === "saveNote")!;
    const result = await tool.run({ input: { text: "hello" } });
    // saveNote's run returns `saved: ${JSON.stringify(input)}` — proves the flue
    // tool routed into the component's freshest <tool> closure.
    expect(String(result)).toContain("saved:");
    expect(String(result)).toContain("hello");
  });
});
