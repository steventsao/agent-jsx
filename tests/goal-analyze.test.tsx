/**
 * Static checks on the goal graph, before anything mounts.
 *
 * `analyzeGoal` reads the runtime TABLE and reports four failures that are
 * otherwise invisible until the goal is running (or, worse, until it silently
 * isn't):
 *
 *   goal-unknown-target     an edge names a phase that was never mounted
 *   goal-unreachable-phase  a phase no path from the initial phase reaches
 *   goal-done-unreachable   the goal can never be met
 *   goal-dead-end-phase     a non-done phase with no way out
 *
 * Reachability comes from @xstate/graph's traversal of the DEV-TIME lowered
 * machine (events namespaced `<phase>.<outcome>`), which is why the checks run
 * in this order: a dangling edge makes the graph unbuildable, so reachability
 * is SKIPPED rather than guessed. Saying nothing about what cannot be decided
 * is the point — a fabricated "unreachable" verdict for a graph with a typo in
 * it would send the author to the wrong bug.
 *
 * The diagnostic shape mirrors `TargetDiagnostic` (src/compile/target-diagnostics.ts)
 * so goal checks can ride the same reporting pipe as target checks.
 */

import { describe, expect, it } from "bun:test";
import { createMachine } from "xstate";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { Phase } from "../src/agent-component.tsx";
import { collectPhases } from "../src/tree.ts";
import { buildGoalTable, type GoalTable } from "../src/goal.ts";
import { analyzeGoal, lowerGoalToMachine } from "../examples/goal/goal-dev.ts";

/** Fixtures go through the real path: JSX -> collectPhases -> table. */
const fold = (declaration: unknown): GoalTable =>
  buildGoalTable(evaluateTree(declaration).flatMap((root) => collectPhases(root)));

/** The dev-time claim "XState accepts/rejects this graph", made honestly. */
const buildMachine = (table: GoalTable) => () =>
  createMachine(lowerGoalToMachine(table, { id: "analysis" }) as never);

describe("analyzeGoal — a healthy goal reports nothing", () => {
  it("clears a graph where every phase is reachable and done is escapable", () => {
    const table = fold(
      <>
        <Phase name="assess" initial on={{ done: "plan" }} />
        <Phase name="plan" on={{ done: "upgrade" }} />
        <Phase name="upgrade" on={{ done: "verify" }} />
        <Phase name="verify" on={{ done: "done", failed: "repair" }} />
        <Phase name="repair" on={{ done: "upgrade" }} />
        <Phase name="done" on={{ release_detected: "assess" }} />
      </>,
    );

    expect(analyzeGoal(table)).toEqual([]);
    expect(buildMachine(table)).not.toThrow();
  });

  it("does not flag `done` as a dead end when it genuinely has no way out", () => {
    // A goal MAY choose an inescapable done; that is a design decision, not a
    // bug, and the dead-end check exempts the done phase by name.
    const table = fold(
      <>
        <Phase name="assess" initial on={{ done: "done" }} />
        <Phase name="done" />
      </>,
    );
    expect(analyzeGoal(table)).toEqual([]);
  });
});

describe("analyzeGoal — dead ends and unreachable phases", () => {
  // `blocked` is reachable but has no way out. `archive` has a way out but
  // nothing reaches it. Two distinct failures, one graph.
  const table = () =>
    fold(
      <>
        <Phase name="assess" initial on={{ done: "plan", blocked: "blocked" }} />
        <Phase name="plan" on={{ done: "done" }} />
        <Phase name="done" on={{ release_detected: "assess" }} />
        <Phase name="blocked" />
        <Phase name="archive" on={{ restore: "assess" }} />
      </>,
    );

  it("reports exactly the unreachable phase and the dead end", () => {
    expect(analyzeGoal(table())).toEqual([
      {
        target: "goal",
        severity: "warning",
        code: "goal-unreachable-phase",
        message: 'phase "archive" is unreachable from the initial phase "assess"; it can never mount.',
      },
      {
        target: "goal",
        severity: "warning",
        code: "goal-dead-end-phase",
        message:
          'phase "blocked" has no outgoing edges; once entered the goal can never leave it.',
      },
    ]);
  });

  it("still builds — these are warnings about a graph XState accepts", () => {
    expect(buildMachine(table())).not.toThrow();
  });
});

describe("analyzeGoal — the goal can never be met", () => {
  it("reports done-unreachability when no path leads to done", () => {
    const table = fold(
      <>
        <Phase name="assess" initial on={{ done: "plan" }} />
        <Phase name="plan" on={{ replan: "assess" }} />
        <Phase name="done" on={{ release_detected: "assess" }} />
      </>,
    );

    expect(analyzeGoal(table)).toEqual([
      {
        target: "goal",
        severity: "warning",
        code: "goal-unreachable-phase",
        message: 'phase "done" is unreachable from the initial phase "assess"; it can never mount.',
      },
      {
        target: "goal",
        severity: "error",
        code: "goal-done-unreachable",
        message:
          'no path from the initial phase "assess" to "done"; the goal can never be met.',
      },
    ]);
  });

  it("reports done-unreachability when no done phase is declared at all", () => {
    const table = fold(
      <>
        <Phase name="assess" initial on={{ done: "plan" }} />
        <Phase name="plan" on={{ replan: "assess" }} />
      </>,
    );

    expect(analyzeGoal(table)).toEqual([
      {
        target: "goal",
        severity: "error",
        code: "goal-done-unreachable",
        message: 'no "done" phase is declared, so the goal can never be met.',
      },
    ]);
  });

  it("honors a goal that names its terminal phase something else", () => {
    const table = fold(
      <>
        <Phase name="assess" initial on={{ done: "shipped" }} />
        <Phase name="shipped" on={{ regressed: "assess" }} />
      </>,
    );

    expect(analyzeGoal(table, { doneState: "shipped" })).toEqual([]);
    // With the default name, the very same graph has no goal to reach.
    expect(analyzeGoal(table).map((d) => d.code)).toEqual(["goal-done-unreachable"]);
  });
});

describe("analyzeGoal — undecidable graphs are reported, not guessed", () => {
  const table = () =>
    fold(
      <>
        <Phase name="assess" initial on={{ done: "plan" }} />
        <Phase name="plan" on={{ done: "shipit" }} />
        <Phase name="done" on={{ release_detected: "assess" }} />
      </>,
    );

  it("reports the dangling edge and SKIPS reachability rather than inventing it", () => {
    // `done` is in fact unreachable here — but the graph cannot be built, so
    // claiming so would be a guess. Fix the edge, then the checks mean something.
    expect(analyzeGoal(table()).map((d) => d.code)).toEqual(["goal-unknown-target"]);
    expect(buildMachine(table())).toThrow();
  });

  it("reports an initial phase that was never declared", () => {
    expect(analyzeGoal({ ...table(), initial: "bootstrap" }).map((d) => d.code)).toEqual([
      "goal-unknown-initial",
      "goal-unknown-target",
    ]);
  });
});
