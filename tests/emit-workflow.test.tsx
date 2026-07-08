/**
 * v0.5 emitter contract — `emitFlueWorkflow` (RED until implemented).
 *
 * The generated module is the flue-side executor wiring: a valid
 * defineWorkflow whose run() drives runReactiveWorkflow with
 * delegate = session.task. Two flue gotchas are load-bearing:
 *   - the workflow `input` schema must be a TOP-LEVEL v.object (flue throws
 *     at module load otherwise — okra/flue gotchas skill);
 *   - the module must be plain .ts-importable (no .tsx module references).
 */

import { describe, expect, it } from "bun:test";
import { emitFlueWorkflow } from "../src/compile/emit-flue.ts";
import { UptimeAgent } from "../examples/uptime-agent.tsx";

const opts = {
  spec: UptimeAgent.spec,
  componentName: "UptimeAgent",
  componentImport: "../agents/uptime-agent.tsx",
  agentModuleImport: "./uptime.flue.ts",
  runtimeImport: "./runtime",
};

describe("emitFlueWorkflow", () => {
  it("emits a defineWorkflow wired to runReactiveWorkflow via session.task", () => {
    const out = emitFlueWorkflow(opts);
    expect(out).toContain("defineWorkflow");
    expect(out).toContain("runReactiveWorkflow");
    expect(out).toContain("session.task");
    // delegate maps a SpawnDescriptor onto flue task delegation by agent kind
    expect(out).toContain("agent:");
  });

  it("declares a top-level v.object input schema (flue load-time rule)", () => {
    const out = emitFlueWorkflow(opts);
    expect(out).toContain("input: v.object(");
    expect(out).not.toContain("input: v.optional(");
  });

  it("honors runtimeImport and never leaks repo-relative paths", () => {
    const out = emitFlueWorkflow(opts);
    expect(out).toContain(`from "./runtime/workflow-executor`);
    expect(out).not.toContain("../../src/");
  });

  it("drives the reactive loop off the spec (impl + initial state), not stringly plumbing", () => {
    const out = emitFlueWorkflow(opts);
    // The loop re-evaluates the agent's OWN tree — spec.impl, not the boundary.
    expect(out).toContain("component: UptimeAgent.spec.impl");
    // Input fallback + props come from the spec; no initial-state-export import.
    expect(out).toContain("UptimeAgent.spec.initialState");
    expect(out).not.toContain("initialUptimeState");
  });
});
