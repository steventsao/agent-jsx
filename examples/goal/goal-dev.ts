/**
 * Dev-time goal analysis: XState as a VISUALIZATION AND ANALYSIS TARGET, never
 * a runtime.
 *
 * The runtime is `src/goal.ts` — a flat table and a ~15-line reducer with zero
 * dependencies. This module lowers that table to a serializable XState v5
 * `createMachine` config for exactly two dev-time purposes:
 *
 *   1. `@xstate/graph` reachability traversal inside `analyzeGoal`.
 *   2. Pasting into Stately for a picture of the goal.
 *
 * Because the goal's outcome vocabulary is PHASE-LOCAL (`done` in `verify` and
 * `done` in `repair` are different edges), the lowered global machine
 * NAMESPACES event names as `<phase>.<outcome>` — a flat statechart needs
 * globally unique event names to be well-formed, and the namespacing is also
 * the honest picture: the source phase is part of the event.
 *
 * `xstate` and `@xstate/graph` are devDependencies; nothing under `src/` may
 * import them. `done` is never lowered to `type: "final"` — a met goal is a
 * regular state a sensor can knock back out.
 */

import { createMachine } from "xstate";
import { getAdjacencyMap } from "@xstate/graph";
import type { GoalTable } from "../../src/goal.ts";

// ---------------------------------------------------------------------------
// Lowering: table -> XState config (data in, data out)

/** One edge. `target` is a phase NAME; guards/actions would be NAMES too. */
export interface GoalEdgeConfig {
  target: string;
}

export interface GoalPhaseConfig {
  on: Record<string, GoalEdgeConfig>;
}

/** An XState v5 `createMachine` config, restricted to what a goal can express
 *  and guaranteed JSON-serializable. Note the absence of `type: "final"`. */
export interface GoalMachineConfig {
  id: string;
  initial: string;
  states: Record<string, GoalPhaseConfig>;
}

export interface LowerGoalOptions {
  /** Machine id — the goal's stable identity in the visualization. */
  id: string;
}

/**
 * Lower the runtime table to an XState machine config.
 *
 * Total over the table it is given: an edge naming a phase that was never
 * declared is carried through VERBATIM rather than dropped, so `analyzeGoal`
 * can report it. Event names are namespaced `<phase>.<outcome>` because the
 * runtime vocabulary is phase-local and a global statechart's is not.
 */
export function lowerGoalToMachine(table: GoalTable, opts: LowerGoalOptions): GoalMachineConfig {
  const states: Record<string, GoalPhaseConfig> = {};
  for (const [phase, outcomes] of Object.entries(table.edges)) {
    const on: Record<string, GoalEdgeConfig> = {};
    for (const [outcome, target] of Object.entries(outcomes)) {
      on[`${phase}.${outcome}`] = { target };
    }
    states[phase] = { on };
  }
  return { id: opts.id, initial: table.initial, states };
}

// ---------------------------------------------------------------------------
// Static checks

/** Mirrors `TargetDiagnostic` from src/compile/target-diagnostics.ts. */
export interface GoalDiagnostic {
  target: "goal";
  severity: "warning" | "error";
  code: string;
  message: string;
}

export interface AnalyzeGoalOptions {
  /** The phase that means "the goal is met". A REGULAR state, never final. */
  doneState?: string;
}

const diagnostic = (
  severity: GoalDiagnostic["severity"],
  code: string,
  message: string,
): GoalDiagnostic => ({ target: "goal", severity, code, message });

/**
 * Static checks over the runtime table, before anything mounts.
 *
 * Reads the TABLE; reachability comes from @xstate/graph's traversal of the
 * lowered machine — and is skipped (honestly, not faked) while unknown targets
 * make the graph undecidable, since XState refuses to construct a machine with
 * a dangling edge at all.
 *
 * Diagnostic order is deterministic: unknown initial, unknown targets,
 * unreachable phases, done-unreachable, dead ends.
 */
export function analyzeGoal(table: GoalTable, opts: AnalyzeGoalOptions = {}): GoalDiagnostic[] {
  const doneState = opts.doneState ?? "done";
  const diagnostics: GoalDiagnostic[] = [];
  const names = Object.keys(table.edges);
  const declared = new Set(names);
  const declaredList = names.join(", ");

  if (!declared.has(table.initial)) {
    diagnostics.push(
      diagnostic(
        "error",
        "goal-unknown-initial",
        `initial phase "${table.initial}" is not a declared <phase>; declared: [${declaredList}].`,
      ),
    );
  }

  let unknownTargets = 0;
  for (const name of names) {
    for (const [outcome, target] of Object.entries(table.edges[name]!)) {
      if (declared.has(target)) continue;
      unknownTargets += 1;
      diagnostics.push(
        diagnostic(
          "error",
          "goal-unknown-target",
          `phase "${name}" edge ${outcome} targets "${target}", which is not a declared <phase>; declared: [${declaredList}].`,
        ),
      );
    }
  }

  if (unknownTargets === 0 && declared.has(table.initial)) {
    const reachable = reachablePhases(table);
    for (const name of names) {
      if (reachable.has(name)) continue;
      diagnostics.push(
        diagnostic(
          "warning",
          "goal-unreachable-phase",
          `phase "${name}" is unreachable from the initial phase "${table.initial}"; it can never mount.`,
        ),
      );
    }
    if (!declared.has(doneState)) {
      diagnostics.push(
        diagnostic(
          "error",
          "goal-done-unreachable",
          `no "${doneState}" phase is declared, so the goal can never be met.`,
        ),
      );
    } else if (!reachable.has(doneState)) {
      diagnostics.push(
        diagnostic(
          "error",
          "goal-done-unreachable",
          `no path from the initial phase "${table.initial}" to "${doneState}"; the goal can never be met.`,
        ),
      );
    }
  }

  for (const name of names) {
    if (name === doneState) continue;
    if (Object.keys(table.edges[name]!).length > 0) continue;
    diagnostics.push(
      diagnostic(
        "warning",
        "goal-dead-end-phase",
        `phase "${name}" has no outgoing edges; once entered the goal can never leave it.`,
      ),
    );
  }

  return diagnostics;
}

/** Every phase @xstate/graph can walk to from the initial phase. */
function reachablePhases(table: GoalTable): Set<string> {
  const machine = createMachine(
    lowerGoalToMachine(table, { id: "analysis" }) as never,
  );
  const adjacency = getAdjacencyMap(machine, {});
  return new Set(
    Object.values(adjacency).map((entry) => String((entry.state as { value: unknown }).value)),
  );
}
