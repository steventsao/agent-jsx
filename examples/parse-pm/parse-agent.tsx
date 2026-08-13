/**
 * ParseAgent — a project manager for a long-running document parse, on the
 * goal layer. The PM is the TOPMOST component (a plain `agentComponent`, no
 * composeAgent) and owns exactly four things:
 *
 *   1. THE STRUCTURED PLAN — a goal machine folded from `<Phase>` declarations
 *      (CF long-running-agents doctrine: the plan doubles as recovery context
 *      and the human-approval surface):
 *
 *        ingest → layout → extract → assemble → verify → done
 *                            ⇅
 *              budget_exhausted ▶ paused ▶ topped_up
 *
 *      Budget exhaustion is a PHASE, not an error — the machine pauses where
 *      the checkbook stopped it and resumes where the checkpoint says.
 *
 *   2. THE CHECKBOOK — every model call is mediated by the PM-side `classify`
 *      grant. It debits a flat per-call ceiling BEFORE calling, meters real
 *      spend from the provider's OWN usage fields after, and REFUSES a call
 *      that would overdraw (dispatching `budget_exhausted`). Children never
 *      hold provider credentials — the provider lives in the PM's ports.
 *
 *   3. ATTENUATED GRANTS — each per-region extractor child receives a ZERO-ARG
 *      `readRegion` capability with the bbox pre-bound parent-side (the
 *      receipt/PDF crop pattern) plus the metered `classify`. Child input is
 *      `{regionId}` alone: no pdf bytes, no bbox, no credentials, no budget.
 *
 *   4. CHECKPOINTS — before every metered call commits, the PM writes
 *      `{phase, completedRegions+results, spend, callCount}` into state and
 *      pushes it through the durable `persist` barrier. Recovery resumes from
 *      the checkpoint; completed regions are never re-called (the ledger is
 *      the call-count oracle).
 *
 * The domain reducer (deterministic unpdf extraction + fold-into-completed)
 * decides WHETHER an outcome happened; the goal table decides WHAT IT MEANS.
 */

import { agentComponent, Phase } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { createStore, type AgentStore } from "../../src/store.ts";
import {
  itemsInBbox,
  joinReadingOrder,
  type Bbox,
  type PositionedItem,
} from "../pdf/core/extract.ts";
import {
  GoalProvider,
  declareGoalTable,
  initGoalState,
  type GoalApi,
  type GoalDispatch,
  type GoalOwnerState,
  type GoalTransition,
} from "../goal/goal-provider.tsx";
import {
  RegionExtractor,
  type ClassifyOutcome,
  type RegionReport,
} from "./region-extractor.tsx";
import { chain, inertPorts, usd, type ParsePorts, type Region } from "./ports.ts";

export const PARSE_PM_ID = "parse-pm";

// ---------------------------------------------------------------------------
// Durable state — all plain JSON, side by side with the goal snapshot.

export interface CompletedRegion {
  text: string;
  label: string;
  costUsd: number;
}

export interface ParseRefusal {
  regionId: string;
  ceilingUsd: number;
  remainingUsd: number;
}

/** The recovery artifact the CF doctrine asks for: written durably BEFORE each
 *  metered call commits, and on every refusal. `results` repeats the completed
 *  map on purpose — the checkpoint alone must be enough to know exactly which
 *  work is paid for. */
export interface ParseCheckpoint {
  seq: number;
  phase: string;
  reason: "before-model-call" | "budget-refused";
  /** The region the metered call concerns. */
  regionId: string;
  completedRegions: string[];
  results: Record<string, CompletedRegion>;
  spentUsd: number;
  callCount: number;
}

/** One attributed log entry: the provider's observation of a dispatch —
 *  applied or refused — plus where the checkbook stood when it happened. */
export interface ParseTransition extends GoalTransition {
  spentUsd: number;
  completed: number;
}

export interface ParsePmState extends GoalOwnerState {
  /** Ingest receipt. The DOC ITSELF lives in PM-owned storage, never here. */
  docBytes: number | null;
  regions: Region[] | null;
  completed: Record<string, CompletedRegion>;
  /** Every metered provider call that committed — the call-count oracle that
   *  survives eviction. Resume must never grow it for a completed region. */
  ledger: Array<{ regionId: string; costUsd: number }>;
  assembled: Array<{ id: string; text: string; label: string }> | null;
  verified: { ok: boolean; mismatches: string[] } | null;
  budgetUsd: number;
  spentUsd: number;
  callCount: number;
  refusals: ParseRefusal[];
  checkpoint: ParseCheckpoint | null;
  log: ParseTransition[];
}

// ---------------------------------------------------------------------------
// Deterministic domain helpers (the extraction spec, reused verbatim).

/** One region's text layer from pre-parsed page items — the SAME membership +
 *  reading-order spec as examples/pdf/core/extract.ts, over a cached parse. */
export function sliceRegion(items: PositionedItem[], bbox: Bbox): string {
  return joinReadingOrder(itemsInBbox(items, bbox));
}

export function assembleSegments(
  regions: Region[],
  completed: Record<string, CompletedRegion>,
): Array<{ id: string; text: string; label: string }> {
  return regions.map((region) => ({
    id: region.id,
    text: completed[region.id]?.text ?? "",
    label: completed[region.id]?.label ?? "",
  }));
}

/** The verify phase's self-check: every assembled segment must equal a FRESH
 *  deterministic re-extraction of its region. A failure holds the phase (the
 *  chess illegal-move pattern: the domain refuses, nothing dispatches). */
export function verifyAssembled(
  items: PositionedItem[],
  regions: Region[],
  assembled: Array<{ id: string; text: string }>,
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const region of regions) {
    const entry = assembled.find((candidate) => candidate.id === region.id);
    if (!entry || entry.text !== sliceRegion(items, region.bbox)) {
      mismatches.push(region.id);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function isRegionReport(value: unknown): value is RegionReport {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RegionReport).regionId === "string" &&
    typeof (value as RegionReport).text === "string" &&
    typeof (value as RegionReport).label === "string"
  );
}

function withCheckpoint(
  state: ParsePmState,
  reason: ParseCheckpoint["reason"],
  regionId: string,
): ParsePmState {
  const completedRegions = (state.regions ?? [])
    .filter((region) => state.completed[region.id] !== undefined)
    .map((region) => region.id);
  const seq = (state.checkpoint?.seq ?? 0) + 1;
  return {
    ...state,
    checkpoint: {
      seq,
      phase: state.goal?.phase ?? "?",
      reason,
      regionId,
      completedRegions,
      results: { ...state.completed },
      spentUsd: state.spentUsd,
      callCount: state.callCount,
    },
  };
}

/** The human gate's write half: raise the budget. The MACHINE notices through
 *  the paused phase's gate task and dispatches `topped_up` itself — the route
 *  never touches the goal directly. */
export function applyTopUp(store: AgentStore<ParsePmState>, amountUsd: number): void {
  store.set((state) => ({ ...state, budgetUsd: usd(state.budgetUsd + amountUsd) }));
}

// ---------------------------------------------------------------------------
// The declaration — single source of truth for the runtime table AND for what
// mounts. Every phase is declared on every render; only the ACTIVE phase's
// children mount. `grants`, when supplied, records every minted dispatch by
// `phase/child` — the test/demo seam for replaying a LATE grant.

export function declareParseGoal(
  store: AgentStore<ParsePmState>,
  ports: ParsePorts,
  grants?: Map<string, GoalDispatch>,
) {
  return ({ dispatchFor }: GoalApi) => {
    const state = store.get();
    const grant = (phase: string, child: string): GoalDispatch => {
      const dispatch = dispatchFor(phase, child);
      grants?.set(`${phase}/${child}`, dispatch);
      return dispatch;
    };

    const pending = (state.regions ?? []).filter(
      (region) => state.completed[region.id] === undefined,
    );

    /** THE CHECKBOOK. Minted per region, per render, parent-side. Debits the
     *  flat ceiling BEFORE the call; meters REAL spend from the provider's
     *  usage fields after; refuses an overdraft by dispatching
     *  `budget_exhausted`. Every path checkpoints durably first. */
    const classifyFor = (region: Region, dispatch: GoalDispatch) =>
      (text: string): ClassifyOutcome | Promise<ClassifyOutcome> => {
        const before = store.get();
        // A grant self-expires with its phase: the reducer's stale check
        // protects the MACHINE, this protects the MONEY. A late capability
        // can never spend the checkbook after the goal moved on.
        if (before.goal?.phase !== "extract" || before.completed[region.id]) {
          return { ok: false, refused: "stale_grant" };
        }
        const ceiling = usd(ports.model.maxCallCostUsd);
        const remaining = usd(before.budgetUsd - before.spentUsd);
        if (ceiling > remaining) {
          store.set((s) =>
            withCheckpoint(
              {
                ...s,
                refusals: [
                  ...s.refusals,
                  { regionId: region.id, ceilingUsd: ceiling, remainingUsd: remaining },
                ],
              },
              "budget-refused",
              region.id,
            ),
          );
          return chain(ports.persist(store.get()), () => {
            // The refusal IS the outcome: the machine pauses exactly here. A
            // second refusal in the same flush lands stale — by design.
            dispatch("budget_exhausted");
            return { ok: false, refused: "budget_exhausted" } as const;
          });
        }
        // CHECKPOINT BEFORE EXPENSIVE WORK: durable before the provider is hit.
        store.set((s) => withCheckpoint(s, "before-model-call", region.id));
        return chain(ports.persist(store.get()), () =>
          chain(ports.model.classifyRegion({ regionId: region.id, text }), (res) => {
            store.set((s) => ({
              ...s,
              spentUsd: usd(s.spentUsd + res.usage.costUsd),
              callCount: s.callCount + 1,
              ledger: [...s.ledger, { regionId: region.id, costUsd: usd(res.usage.costUsd) }],
            }));
            return { ok: true, label: res.label, costUsd: usd(res.usage.costUsd) } as const;
          }),
        );
      };

    /** The fold. Domain first, then goal: only a valid, in-phase report folds;
     *  the LAST fold spends the phase's `extracted` edge. A late report folds
     *  NOTHING but still runs its dispatch, so the reducer records the refusal
     *  as `stale` in the durable log — attribution, not trust. */
    const onExtractedFor = (region: Region, dispatch: GoalDispatch) =>
      (report: unknown): void => {
        if (!isRegionReport(report) || report.regionId !== region.id) return;
        const before = store.get();
        if (before.goal?.phase !== "extract") {
          dispatch("extracted"); // provably stale: minted for extract, extract is gone
          return;
        }
        if (before.completed[region.id]) return; // duplicate within the phase
        store.set((s) => ({
          ...s,
          completed: {
            ...s.completed,
            [region.id]: {
              text: report.text,
              label: report.label,
              costUsd: usd(report.costUsd),
            },
          },
        }));
        const after = store.get();
        if ((after.regions ?? []).every((r) => after.completed[r.id] !== undefined)) {
          dispatch("extracted");
        }
      };

    return (
      <>
        <Phase name="ingest" initial on={{ ingested: "layout" }}>
          {state.docBytes === null && (
            <task
              name="ingest"
              run={ports.ingest}
              onDone={(result) => {
                const bytes = (result as { bytes?: unknown } | null)?.bytes;
                if (typeof bytes !== "number") return;
                store.set((s) => ({ ...s, docBytes: bytes }));
                grant("ingest", "task:ingest")("ingested");
              }}
            />
          )}
        </Phase>

        <Phase name="layout" on={{ layouted: "extract" }}>
          {state.regions === null && (
            <task
              name="layout"
              run={ports.layout}
              onDone={(result) => {
                if (!Array.isArray(result)) return;
                store.set((s) => ({ ...s, regions: result as Region[] }));
                grant("layout", "task:layout")("layouted");
              }}
            />
          )}
        </Phase>

        <Phase
          name="extract"
          on={{ extracted: "assemble", budget_exhausted: "paused" }}
        >
          {state.regions &&
            pending.map((region) => (
              <RegionExtractor
                key={region.id}
                name={`extract:${region.id}`}
                regionId={region.id}
                // ATTENUATED: zero-arg, THIS region's bbox bound right here.
                readRegion={() => sliceRegion(ports.pageItems(), region.bbox)}
                classify={classifyFor(region, grant("extract", `extractor:${region.id}`))}
                onExtracted={onExtractedFor(region, grant("extract", `extractor:${region.id}`))}
              />
            ))}
        </Phase>

        <Phase name="paused" on={{ topped_up: "extract" }}>
          {/* The human gate: a bearer-guarded route raises budgetUsd; the gate
              task (name keyed by the budget) notices the new checkbook and
              spends the paused phase's one edge. Nothing else mounts here. */}
          <task
            name={`topup-gate:${state.budgetUsd}`}
            run={() =>
              usd(store.get().budgetUsd - store.get().spentUsd) >=
              usd(ports.model.maxCallCostUsd)
            }
            onDone={(covers) => {
              if (covers === true) grant("paused", "human:topup")("topped_up");
            }}
          />
        </Phase>

        <Phase name="assemble" on={{ assembled: "verify" }}>
          {state.assembled === null && state.regions && (
            <task
              name="assemble"
              run={() => assembleSegments(store.get().regions!, store.get().completed)}
              onDone={(segments) => {
                if (!Array.isArray(segments)) return;
                store.set((s) => ({
                  ...s,
                  assembled: segments as ParsePmState["assembled"],
                }));
                grant("assemble", "task:assemble")("assembled");
              }}
            />
          )}
        </Phase>

        <Phase name="verify" on={{ verified: "done" }}>
          {state.verified === null && state.regions && state.assembled && (
            <task
              name="verify"
              run={() =>
                verifyAssembled(ports.pageItems(), store.get().regions!, store.get().assembled!)
              }
              onDone={(verdict) => {
                const v = verdict as { ok?: unknown; mismatches?: string[] } | null;
                if (typeof v?.ok !== "boolean") return;
                store.set((s) => ({
                  ...s,
                  verified: { ok: v.ok as boolean, mismatches: v.mismatches ?? [] },
                }));
                // A failed self-check HOLDS the phase — diagnosis, not a crash.
                if (v.ok === true) grant("verify", "task:verify")("verified");
              }}
            />
          )}
        </Phase>

        {/* Met, by convention: no children, no outgoing edges. Nothing here is
            terminal by type — a future sensor edge could knock it back out. */}
        <Phase name="done" on={{}} />
      </>
    );
  };
}

/** Observation seam: append every dispatched outcome — applied or refused —
 *  to the durable attributed log, stamped with where the checkbook stood. */
export function recordParseTransition(store: AgentStore<ParsePmState>) {
  return (transition: GoalTransition): void => {
    store.set((state) => ({
      ...state,
      log: [
        ...state.log,
        {
          ...transition,
          spentUsd: state.spentUsd,
          completed: Object.keys(state.completed).length,
        },
      ],
    }));
  };
}

// ---------------------------------------------------------------------------
// Table + initial state. The table is folded FROM the declaration above, so a
// phase that is analyzed is a phase that can mount, and vice versa.

const bootstrapDomain: ParsePmState = {
  goal: null,
  docBytes: null,
  regions: null,
  completed: {},
  ledger: [],
  assembled: null,
  verified: null,
  budgetUsd: 0,
  spentUsd: 0,
  callCount: 0,
  refusals: [],
  checkpoint: null,
  log: [],
};

export const PARSE_GOAL_TABLE = declareGoalTable(
  declareParseGoal(createStore(bootstrapDomain), inertPorts()),
);

export const initialParsePmState: ParsePmState = initGoalState(
  PARSE_GOAL_TABLE,
  bootstrapDomain,
);

// ---------------------------------------------------------------------------
// The root — a plain agentComponent. The environment hands it its equipment
// (ports) exactly the way it hands it its store; everything below the root
// gets only narrowed grants.

export const ParseAgent = agentComponent<{ ports: ParsePorts }, ParsePmState>({
  agentName: "parse-agent",
  initialState: initialParsePmState,
  displayName: "Agent JSX Parse PM",
  description:
    "A project-manager agent for a long-running document parse: goal machine as the structured plan, PM-mediated budget, attenuated per-region grants, durable checkpoints.",
  sampleProps: { ports: inertPorts() },
  impl: ({ ports, store }) => {
    const state = useAgentState(store);
    const phase = state.goal?.phase ?? PARSE_GOAL_TABLE.initial;
    const regionCount = state.regions?.length ?? 0;
    const doneCount = Object.keys(state.completed).length;
    return (
      <>
        <GoalProvider
          table={PARSE_GOAL_TABLE}
          store={store}
          onTransition={recordParseTransition(store)}
        >
          {declareParseGoal(store, ports)}
        </GoalProvider>
        <prompt>
          <sys p={10}>
            Parse PM. Plan: ingest ▶ layout ▶ extract ▶ assemble ▶ verify ▶
            done, with extract ⇄ paused as the budget gate. Phase: {phase}.
            Budget: ${state.spentUsd.toFixed(4)} spent of $
            {state.budgetUsd.toFixed(4)} across {state.callCount} calls.
          </sys>
          <msg p={7}>
            {regionCount === 0
              ? "awaiting layout."
              : `${doneCount}/${regionCount} regions complete${
                  state.checkpoint ? `; checkpoint #${state.checkpoint.seq} (${state.checkpoint.reason})` : ""
                }.`}
          </msg>
          {state.refusals.length > 0 && (
            <msg p={8}>
              budget refused {state.refusals.length} call(s); last at region{" "}
              {state.refusals.at(-1)!.regionId}. Top up to resume from the
              checkpoint.
            </msg>
          )}
        </prompt>
      </>
    );
  },
});
