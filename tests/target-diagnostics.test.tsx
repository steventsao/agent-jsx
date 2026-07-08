import { describe, expect, it } from "bun:test";
import { emitFlueChild } from "../src/compile/emit-flue.ts";
import { flueChildTargetDiagnostics } from "../src/compile/target-diagnostics.ts";
import { Investigator } from "../examples/investigator.tsx";
import type { ChildAgentSpec } from "../src/compile/emit-cloudflare.ts";

const investigator: ChildAgentSpec = {
  spec: Investigator.spec,
  exportName: "Investigator",
  importPath: "../agents/investigator.tsx",
};

describe("target diagnostics", () => {
  it("warns when flue task profiles cannot preserve child-local state and infra", () => {
    const diagnostics = flueChildTargetDiagnostics(investigator);
    expect(diagnostics.map((d) => d.code)).toEqual([
      "flue-child-state-not-durable",
      "flue-child-infra-not-emitted",
    ]);
    expect(diagnostics[0]!.message).toContain("checked");
    expect(diagnostics[1]!.message).toContain("tool:fetch-logs");
    expect(diagnostics[1]!.message).toContain("schedule:sla-deadline");
  });

  it("embeds flue target warnings in generated child profiles", () => {
    const out = emitFlueChild(investigator);
    expect(out).toContain("TARGET WARNING [flue-child-state-not-durable]");
    expect(out).toContain("TARGET WARNING [flue-child-infra-not-emitted]");
    expect(out).toContain("defineAgentProfile");
  });
});
