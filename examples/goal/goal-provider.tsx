/**
 * GoalProvider — a headless, domain-free supervisor for a long-horizon goal.
 *
 * What it owns:  the goal snapshot (`{ phase }`), as plain JSON in durable
 *                agent state, moved only through `goalReducer` (src/goal.ts).
 * What it does:  picks which `<phase>` fragment is mounted, and MINTS the
 *                grants that let children move the goal.
 * What it never does: sequence anything. JSX supervises; it does not step.
 *
 * THE AUTHORING SHAPE
 *
 *   <GoalProvider table={table} store={store}>
 *     {({ dispatchFor }) => (
 *       <>
 *         <phase name="assess" initial on={{ done: "plan" }}>
 *           <Worker name="goal:assess" task="assess"
 *                   onOutcome={result(dispatchFor("assess", "goal:assess"))} />
 *         </phase>
 *         <phase name="plan" on={{ done: "upgrade" }}>…</phase>
 *       </>
 *     )}
 *   </GoalProvider>
 *
 * Every phase is DECLARED on every render — that is what makes the transition
 * graph collectable as data no matter which phase happens to be active. Only
 * the active phase's CHILDREN are mounted, so the reconciler spawns and revokes
 * per-phase children exactly the way it spawns and revokes any other
 * conditionally-rendered boundary. Nothing about a goal is a special case.
 *
 * FACETS-STYLE SOURCE ATTRIBUTION
 *
 * `dispatchFor(phase, child?)` mints a grant that closes over its SOURCE at
 * mint time — exactly like cloudflare/agents facets, where a child calls
 * `parentAgent(...)` methods passing only its payload and the parent-side
 * handler knows the child's name. The child's whole API is
 * `dispatch(outcome, payload?)`: a bare, child-local outcome name, zero
 * knowledge of the graph, phase names, or global events. Parent-side, the
 * handler wraps it into `{ type: outcome, source: { phase, child }, payload }`
 * and runs the reducer — so a late callback from a child of a phase the goal
 * has already left is provably STALE and cannot corrupt the machine.
 *
 * WHY `result(dispatch)` AND NOT A BARE FUNCTION
 *
 * The minted dispatch is the machine's only door. Handing it to a child as a
 * raw function prop is rejected at render time (see tests/result-grant.test.tsx):
 * a boundary without an explicit grant grants nothing. `result(dispatch)` lowers
 * to serializable binding METADATA on the child's record — the child never holds
 * the closure, the HOST invokes the parent-side sink when the child's work
 * completes, and the route (not the function) is what survives hibernation. So
 * "which children may move this goal, and with what" is readable off the
 * composition, and off the persisted records, without reading child code.
 */

import type { ReactNode } from "react";
import { Phase } from "../../src/agent-component.tsx";
import { useAgentState, type AgentStore } from "../../src/state.ts";
import { evaluateTree } from "../../src/compile/evaluate.ts";
import { collectPhases } from "../../src/tree.ts";
import {
  buildGoalTable,
  goalInit,
  goalReducer,
  type BuildGoalTableOptions,
  type GoalEvent,
  type GoalSnapshot,
  type GoalSource,
  type GoalTable,
} from "../../src/goal.ts";

/** The one reserved slot a goal owner must carry. Domain state lives beside it. */
export interface GoalOwnerState extends Record<string, unknown> {
  /** Persisted goal snapshot. `null` before the first transition. */
  goal: GoalSnapshot | null;
}

/** A child's whole API: emit a bare outcome. No graph, no phases, no events. */
export type GoalDispatch = (outcome: string, payload?: unknown) => void;

export interface GoalTransition {
  /** The child-local outcome name as emitted. */
  outcome: string;
  /** Attribution stamped at grant-mint time, never by the child. */
  source: GoalSource;
  from: string;
  to: string;
  /** False when the reducer ignored the event — see `ignored` for why. */
  changed: boolean;
  ignored?: "stale" | "unknown";
}

/** What the provider hands its render prop. Roles, not markup. */
export interface GoalApi {
  /** The active phase — which fragment is mounted. */
  phase: string;
  /** The persisted snapshot, for anything that needs to read the goal. */
  snapshot: GoalSnapshot;
  /**
   * Mint a grant for a child mounted in `phase`. The returned dispatch closes
   * over `{ phase, child }` — the SOURCE — so the child only ever supplies a
   * bare outcome. Wrap it as `result(dispatchFor(...))` at the boundary.
   */
  dispatchFor: (phase: string, child?: string) => GoalDispatch;
}

export interface GoalProviderProps<S extends GoalOwnerState> {
  table: GoalTable;
  store: AgentStore<S>;
  children: (api: GoalApi) => ReactNode;
  /** Observation seam: every dispatched outcome, applied or ignored. */
  onTransition?: (transition: GoalTransition) => void;
}

/** Seed durable state with the table's entry snapshot. */
export function initGoalState<S extends Record<string, unknown>>(
  table: GoalTable,
  domain: S,
): S & GoalOwnerState {
  return { ...domain, goal: goalInit(table) };
}

/**
 * Build the runtime table from a goal declaration: JSX -> phases -> table.
 *
 * The declaration is evaluated with an INERT api (no phase, grants that go
 * nowhere), because the phase graph must not depend on which phase is active —
 * a goal whose shape changed with its state could not be checked before it
 * ran. The evaluation goes through the same `collectPhases` sweep the
 * reconciler's committed tree does, so what is analyzed is what mounts.
 */
export function declareGoalTable(
  declare: (api: GoalApi) => ReactNode,
  opts: BuildGoalTableOptions = {},
): GoalTable {
  const inert: GoalApi = {
    phase: "",
    snapshot: { phase: "" },
    dispatchFor: () => () => {},
  };
  const phases = evaluateTree(declare(inert)).flatMap((root) => collectPhases(root));
  return buildGoalTable(phases, opts);
}

export function GoalProvider<S extends GoalOwnerState>({
  table,
  store,
  children,
  onTransition,
}: GoalProviderProps<S>): ReactNode {
  const state = useAgentState(store);
  // Pure fallback: an un-seeded goal renders its entry phase without writing
  // during render. `initGoalState` is the explicit seed.
  const snapshot = state.goal ?? goalInit(table);
  const phase = snapshot.phase;

  const dispatchFor = (sourcePhase: string, child?: string): GoalDispatch => {
    // The SOURCE is fixed here, at mint time. Whatever the child does with its
    // dispatch later, it can only ever spend this phase's vocabulary.
    const source: GoalSource = { phase: sourcePhase, ...(child !== undefined ? { child } : {}) };
    return (outcome, payload) => {
      // Read through the store, never the render closure: a child completing in
      // the same flush as an earlier one must see the earlier transition.
      const current = store.get().goal ?? goalInit(table);
      const event: GoalEvent = {
        type: outcome,
        source,
        ...(payload !== undefined ? { payload } : {}),
      };
      const step = goalReducer(table, current, event);
      onTransition?.({
        outcome,
        source,
        from: current.phase,
        to: step.next.phase,
        changed: step.changed,
        ...(step.ignored !== undefined ? { ignored: step.ignored } : {}),
      });
      if (!step.changed) return;
      store.set((prev) => ({ ...prev, goal: step.next }) as S);
    };
  };

  const declarations = phaseDeclarations(children({ phase, snapshot, dispatchFor }));

  return (
    <>
      {declarations.map((declaration) => (
        <phase
          key={declaration.name}
          name={declaration.name}
          on={declaration.on}
          {...(declaration.initial ? { initial: true } : {})}
        >
          {declaration.name === phase ? declaration.children : null}
        </phase>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Child inspection — the createAgentBinder precedent: the provider reads the
// elements it was handed and owns what actually mounts. This walk is also the
// provider's REGISTRY of phases (facets style): it knows every phase it could
// mint grants for, no matter which one is active.

interface PhaseDeclaration {
  name: string;
  on: Record<string, string>;
  initial: boolean;
  children: ReactNode;
}

const FRAGMENT = Symbol.for("react.fragment");

const describeType = (type: unknown): string =>
  typeof type === "function"
    ? (type as { name?: string }).name || "anonymous component"
    : String(type);

/**
 * Flatten the render-prop result into phase declarations.
 *
 * Only a phase declaration — the public `<Phase>` component (matched by
 * identity, the createAgentBinder precedent) or the lowercase `phase` host
 * intrinsic it renders to — plus fragments/arrays/conditionals around it is
 * legal here. A stray boundary at this level would mount in EVERY phase while
 * looking like it belonged to one, so it is rejected loudly rather than
 * quietly hoisted.
 */
function phaseDeclarations(node: ReactNode): PhaseDeclaration[] {
  const out: PhaseDeclaration[] = [];
  const seen = new Set<string>();

  const walk = (value: unknown): void => {
    if (value == null || typeof value === "boolean") return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    if (typeof value !== "object" || !("type" in (value as object))) {
      throw new Error(
        `[goal] GoalProvider children may only declare <phase> elements; found ${JSON.stringify(value)}`,
      );
    }
    const element = value as { type: unknown; props?: Record<string, unknown> };
    if (element.type === FRAGMENT) {
      walk((element.props as { children?: unknown } | undefined)?.children);
      return;
    }
    if (element.type !== "phase" && element.type !== Phase) {
      throw new Error(
        `[goal] GoalProvider children may only declare <Phase> elements; found <${describeType(element.type)}>`,
      );
    }
    const { name, on, initial, children } = (element.props ?? {}) as {
      name?: unknown;
      on?: unknown;
      initial?: unknown;
      children?: ReactNode;
    };
    if (typeof name !== "string" || !name) {
      throw new Error("[goal] <phase> requires a stable string `name` prop");
    }
    if (seen.has(name)) {
      throw new Error(`[goal] duplicate <phase name="${name}"> in one GoalProvider`);
    }
    seen.add(name);
    out.push({
      name,
      on: (on ?? {}) as Record<string, string>,
      initial: initial === true,
      children: children ?? null,
    });
  };

  walk(node);
  return out;
}
