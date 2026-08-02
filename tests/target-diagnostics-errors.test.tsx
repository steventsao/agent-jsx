/**
 * Target diagnostics FAILURE branches — when a component cannot be statically
 * evaluated (its impl throws), the diagnostics functions must DEGRADE to a
 * fallback warning instead of propagating the render error:
 *
 *   - flueChildTargetDiagnostics → a "flue-child-analysis-failed" warning that
 *     carries the original error message (target-diagnostics.ts:62-71);
 *   - thinkTargetDiagnostics → a single "think-analysis-failed" warning, the
 *     whole result replaced (target-diagnostics.ts:114-123).
 *
 * The happy-path shapes (per-kind warnings, emitted header comments) live in
 * target-diagnostics.test.tsx and emit-think.test.tsx.
 */

import { describe, expect, it } from "bun:test";
import { agentComponent } from "../src/agent-component.tsx";
import {
  flueChildTargetDiagnostics,
  thinkTargetDiagnostics,
  formatTargetDiagnosticsForComment,
} from "../src/compile/target-diagnostics.ts";

const ThrowingError = agentComponent({
  agentName: "throwing-error",
  initialState: {},
  impl: () => {
    throw new Error("render exploded");
  },
});

const ThrowingString = agentComponent({
  agentName: "throwing-string",
  initialState: {},
  impl: () => {
    // A non-Error throw exercises the String(error) branch of the fallback.
    throw "string failure";
  },
});

const StatefulThrower = agentComponent({
  agentName: "stateful-thrower",
  initialState: { runs: 0 },
  impl: () => {
    throw new Error("render exploded");
  },
});

describe("flueChildTargetDiagnostics — analysis failure falls back to a warning", () => {
  it("returns the flue-child-analysis-failed warning with the Error message", () => {
    const diagnostics = flueChildTargetDiagnostics({
      spec: ThrowingError.spec,
      exportName: "ThrowingError",
      importPath: "./throwing-error.tsx",
    });
    expect(diagnostics).toEqual([
      {
        target: "flue",
        severity: "warning",
        code: "flue-child-analysis-failed",
        message:
          "could not statically inspect the child component for flue target limitations: render exploded",
      },
    ]);
  });

  it("stringifies non-Error throws", () => {
    const diagnostics = flueChildTargetDiagnostics({
      spec: ThrowingString.spec,
      exportName: "ThrowingString",
      importPath: "./throwing-string.tsx",
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe("flue-child-analysis-failed");
    expect(diagnostics[0]!.message).toContain("string failure");
  });

  it("keeps the state warning that was collected BEFORE the render failed", () => {
    const diagnostics = flueChildTargetDiagnostics({
      spec: StatefulThrower.spec,
      exportName: "StatefulThrower",
      importPath: "./stateful-thrower.tsx",
    });
    expect(diagnostics.map((d) => d.code)).toEqual([
      "flue-child-state-not-durable",
      "flue-child-analysis-failed",
    ]);
  });
});

describe("thinkTargetDiagnostics — analysis failure replaces the whole result", () => {
  it("returns exactly one think-analysis-failed warning", () => {
    expect(thinkTargetDiagnostics(ThrowingError.spec)).toEqual([
      {
        target: "think",
        severity: "warning",
        code: "think-analysis-failed",
        message: "could not statically inspect the component for think-mode limitations.",
      },
    ]);
  });

  it("does NOT propagate the render error", () => {
    expect(() => thinkTargetDiagnostics(ThrowingError.spec)).not.toThrow();
  });

  it("the fallback still formats as a loud header comment", () => {
    const comment = formatTargetDiagnosticsForComment(thinkTargetDiagnostics(ThrowingError.spec));
    expect(comment).toContain("TARGET WARNING [think-analysis-failed]");
  });
});
