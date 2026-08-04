/**
 * The goal runtime: a flat transition table and a pure reducer. No xstate.
 *
 *   <phase name on>  --collectPhases-->  CollectedPhase[]
 *                    --buildGoalTable-->  GoalTable   (plain serializable data)
 *                    --goalReducer----->  pure, source-attributed transitions
 *
 * THREE RULES THIS MODULE EXISTS TO ENFORCE:
 *
 * 1. HIERARCHY LIVES IN JSX; TRANSITIONS ARE A TABLE LOOKUP. The nesting of
 *    providers is the composition's business. What a goal DOES is a flat
 *    Redux-style table — `edges[phase][outcome] -> target` — small enough to
 *    read whole and serializable enough to hibernate.
 *
 * 2. THE VOCABULARY IS PHASE-LOCAL. An outcome name like `done` or `failed` is
 *    scoped to the phase that declared it: two phases may both use `done` and
 *    mean different edges. Children stay dumb dispatchers — they emit a bare,
 *    child-local outcome; the PARENT that minted their grant knows the source
 *    phase (cloudflare/agents facets style) and contextualizes the event.
 *
 * 3. THE SOURCE IS PART OF THE EVENT. Every event carries the phase (and
 *    optionally the child) whose grant emitted it. A late callback from a child
 *    of a phase the goal has already left is ignored as `stale` — attribution
 *    is what keeps the machine incorruptible under out-of-order completion.
 *
 * `done` is a regular phase like any other: nothing here is terminal, so a met
 * goal can be knocked back out by a sensor edge. Termination, if a goal ever
 * needs it, is despawning the provider, not a special state.
 *
 * XState is NOT here: it is demoted to a dev-time analysis/visualization
 * target (see examples/goal/goal-dev.ts), and stays a devDependency.
 */

import type { CollectedPhase } from "./tree.ts";

// ---------------------------------------------------------------------------
// The table

/**
 * The whole machine, as data: entry phase plus `edges[phase][outcome] ->
 * target phase`. Every declared phase has a key in `edges` (possibly empty),
 * so the set of phases is recoverable from the table alone. Nothing in it is
 * a closure; it survives JSON, a fixture, and a wire.
 */
export interface GoalTable {
  initial: string;
  edges: Record<string, Record<string, string>>;
}

export interface BuildGoalTableOptions {
  /** Entry phase. Defaults to the phase marked `initial`, else the first declared. */
  initial?: string;
}

/**
 * Fold collected `<phase>` declarations into the transition table.
 *
 * Pure and total over the phases it is given: an edge naming a phase that was
 * never mounted is carried through VERBATIM rather than dropped, so a dev-time
 * analyzer can report it. Silently pruning a dangling edge would turn an
 * authoring bug into a machine that merely does nothing.
 */
export function buildGoalTable(
  phases: readonly CollectedPhase[],
  opts: BuildGoalTableOptions = {},
): GoalTable {
  if (phases.length === 0) {
    throw new Error("[goal] a goal must declare at least one <phase>");
  }

  const edges: Record<string, Record<string, string>> = {};
  for (const phase of phases) {
    if (edges[phase.name]) {
      throw new Error(
        `[goal] duplicate <phase name="${phase.name}">: a phase name is the machine's state key and must be unique`,
      );
    }
    edges[phase.name] = { ...phase.on };
  }

  const marked = phases.filter((phase) => phase.initial).map((phase) => phase.name);
  if (marked.length > 1) {
    throw new Error(`[goal] more than one <phase initial>: ${marked.join(", ")}`);
  }

  return { initial: opts.initial ?? marked[0] ?? phases[0]!.name, edges };
}

// ---------------------------------------------------------------------------
// The reducer

/** The goal's own durable state — minimal and plain. */
export interface GoalSnapshot {
  phase: string;
}

/** Who emitted an outcome: the phase whose grant it was, and optionally which
 *  child. Stamped by the PARENT at grant-mint time, never by the child. */
export interface GoalSource {
  phase: string;
  child?: string;
}

/** A contextualized outcome: `type` is the child-local outcome name; `source`
 *  is the attribution the minting parent added around it. */
export interface GoalEvent {
  type: string;
  source: GoalSource;
  payload?: unknown;
}

export interface GoalStep {
  /** The next snapshot. The SAME object as the input when nothing changed. */
  next: GoalSnapshot;
  changed: boolean;
  /** Why a no-op was a no-op: `stale` — the event's source phase is not the
   *  current phase (a late callback after a transition); `unknown` — the
   *  current phase declares no edge for this outcome. */
  ignored?: "stale" | "unknown";
}

/** The machine's entry snapshot. */
export function goalInit(table: GoalTable): GoalSnapshot {
  return { phase: table.initial };
}

/**
 * The goal's ONE state transition: (table, snapshot, event) -> next.
 *
 * Pure table lookup. Never mutates its inputs, so replaying an event log from
 * the same snapshot always lands on the same result. A stale source loses to
 * the current phase BEFORE the outcome is even looked up: a phase's vocabulary
 * can only be spent by that phase's own children, while it is the phase.
 */
export function goalReducer(
  table: GoalTable,
  snapshot: GoalSnapshot,
  event: GoalEvent,
): GoalStep {
  if (event.source.phase !== snapshot.phase) {
    return { next: snapshot, changed: false, ignored: "stale" };
  }
  const target = table.edges[snapshot.phase]?.[event.type];
  if (target === undefined) {
    return { next: snapshot, changed: false, ignored: "unknown" };
  }
  return { next: { phase: target }, changed: true };
}
