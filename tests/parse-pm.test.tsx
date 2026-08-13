/**
 * ParseAgent — the project-manager pattern on the goal layer (examples/parse-pm).
 *
 * The claims under test, in the mission's order:
 *
 *  1. THE PLAN IS A TABLE. ingest ▶ layout ▶ extract ▶ assemble ▶ verify ▶
 *     done plus extract ⇄ paused folds from the `<Phase>` declarations and
 *     passes analyzeGoal clean; a dangling edge surfaces as a diagnostic.
 *
 *  2. ONLY THE ACTIVE PHASE MOUNTS, and what mounts is attenuated: an
 *     extractor's serializable input is {regionId} alone — no pdf bytes, no
 *     bbox, no credential — while its grant ACL is exactly
 *     {readRegion: method, classify: method, onExtracted: result}.
 *
 *  3. THE CHECKBOOK PAUSES AT THE EXACT BOUNDARY. $0.025 against a $0.01
 *     ceiling affords title+authors ($0.017 real usage), refuses
 *     abstract-left, and the durable checkpoint records exactly the paid
 *     regions — written BEFORE each provider call (event-order oracle).
 *
 *  4. RESUME NEVER RE-BUYS. Top-up + a second drive completes the run with
 *     exactly two more provider calls; the ledger stays duplicate-free.
 *
 *  5. CHECKPOINT REPLAY IS DETERMINISTIC. Resuming from the JSON round-trip
 *     of the paused state folds to byte-identical final state.
 *
 *  6. THE ORACLE BITES. Segments at verify deep-equal the golden fixture; a
 *     shifted bbox cannot reproduce it.
 *
 *  7. STALENESS. A late grant/report from a phase the goal has left is
 *     refused as `stale` by the reducer, and the classify capability itself
 *     self-expires (the checkbook cannot be spent by a stale grant).
 */

import { describe, expect, it } from "bun:test";

import { mountAgent } from "../src/agent.ts";
import { SimHost, type World } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import { collectInfra } from "../src/tree.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { analyzeGoal } from "../examples/goal/goal-dev.ts";
import {
  GoalProvider,
  type GoalDispatch,
  type GoalTransition,
} from "../examples/goal/goal-provider.tsx";
import { b64ToBytes, pageTextItems } from "../examples/pdf/core/extract.ts";
import { SAMPLE_PDF_B64 } from "../fixtures/pdf/sample-pdf.ts";
import { REGIONS, type Region } from "../fixtures/pdf/regions.ts";
import golden from "../fixtures/pdf/golden-segments.json";
import {
  applyTopUp,
  declareParseGoal,
  initialParsePmState,
  PARSE_GOAL_TABLE,
  ParseAgent,
  recordParseTransition,
  type ParsePmState,
} from "../examples/parse-pm/parse-agent.tsx";
import { driveToRest, playRegionExtractor } from "../examples/parse-pm/drive.ts";
import { FAKE_PROVIDER_KEY, fakeProvider } from "../examples/parse-pm/fake-provider.ts";
import { usd, type ModelProvider, type ParsePorts } from "../examples/parse-pm/ports.ts";

// ---------------------------------------------------------------------------
// Shared fixtures. The page parse happens once; every region slice and the
// SimHost world stay synchronous.

const pageItems = await pageTextItems(b64ToBytes(SAMPLE_PDF_B64));
const GOLDEN = golden as Array<{ id: string; text: string }>;
const goldenText = new Map(GOLDEN.map((segment) => [segment.id, segment.text]));
const PDF_MARKER = SAMPLE_PDF_B64.slice(0, 64);

function makePorts(regions: Region[] = REGIONS, events?: string[]) {
  const provider = fakeProvider();
  const model: ModelProvider = {
    maxCallCostUsd: provider.maxCallCostUsd,
    classifyRegion: (input) => {
      events?.push(`call:${input.regionId}`);
      return provider.classifyRegion(input);
    },
  };
  const ports: ParsePorts = {
    ingest: () => ({ bytes: SAMPLE_PDF_B64.length }),
    layout: () => regions,
    pageItems: () => pageItems,
    model,
    persist: (state) => {
      events?.push(`persist:${(state as ParsePmState).checkpoint?.seq ?? 0}`);
    },
  };
  return { ports, provider };
}

const startState = (budgetUsd: number): ParsePmState => ({
  ...initialParsePmState,
  budgetUsd,
});

const atExtract = (budgetUsd = 0.05): ParsePmState => ({
  ...initialParsePmState,
  budgetUsd,
  docBytes: SAMPLE_PDF_B64.length,
  regions: REGIONS,
  goal: { phase: "extract" },
});

const drive = (state: ParsePmState, ports: ParsePorts) =>
  driveToRest({
    component: ParseAgent.spec.impl,
    props: { ports },
    initialState: state,
    play: playRegionExtractor,
  });

const mountRecords = (store: ReturnType<typeof createStore<ParsePmState>>, ports: ParsePorts) =>
  evaluateTree(
    <GoalProvider table={PARSE_GOAL_TABLE} store={store}>
      {declareParseGoal(store, ports)}
    </GoalProvider>,
  ).flatMap((root) => collectInfra(root));

// ---------------------------------------------------------------------------

describe("parse-pm goal table — the structured plan", () => {
  it("folds the declaration into the flat transition table", () => {
    expect(PARSE_GOAL_TABLE).toEqual({
      initial: "ingest",
      edges: {
        ingest: { ingested: "layout" },
        layout: { layouted: "extract" },
        extract: { extracted: "assemble", budget_exhausted: "paused" },
        paused: { topped_up: "extract" },
        assemble: { assembled: "verify" },
        verify: { verified: "done" },
        done: {},
      },
    });
  });

  it("passes the static goal checks clean", () => {
    expect(analyzeGoal(PARSE_GOAL_TABLE)).toEqual([]);
  });

  it("surfaces a dangling edge as a diagnostic (the analyzer bites)", () => {
    const broken = {
      initial: "ingest",
      edges: { ingest: { ingested: "nowhere" } },
    };
    expect(analyzeGoal(broken).map((d) => d.code)).toContain("goal-unknown-target");
  });

  it("seeds the initial durable state at the entry phase", () => {
    expect(initialParsePmState.goal).toEqual({ phase: "ingest" });
    expect(initialParsePmState.spentUsd).toBe(0);
    expect(initialParsePmState.checkpoint).toBeNull();
    expect(initialParsePmState.log).toEqual([]);
  });
});

describe("parse-pm composition — only the active phase mounts, attenuated", () => {
  it("mounts a single ingest task at the entry phase — no subagents", () => {
    const { ports } = makePorts();
    const records = mountRecords(createStore(startState(0.05)), ports);
    expect(records.filter((r) => r.kind === "subagent")).toEqual([]);
    expect(records.filter((r) => r.kind === "task").map((r) => r.name)).toEqual(["ingest"]);
  });

  it("mounts one extractor per pending region at extract, input = {regionId} only", () => {
    const { ports } = makePorts();
    const subagents = mountRecords(createStore(atExtract()), ports).filter(
      (r) => r.kind === "subagent",
    );
    expect(subagents.map((r) => r.name)).toEqual([
      "extract:title",
      "extract:authors",
      "extract:abstract-left",
      "extract:intro-left",
    ]);
    for (const record of subagents) {
      // The serializable input — exactly what would cross as setProps.
      expect(Object.keys(record.config).sort()).toEqual(["kind", "regionId"]);
      expect(record.config.kind).toBe("region-extractor");
      // The complete grant ACL, readable off the record.
      expect(record.bindings).toEqual({
        readRegion: { kind: "method" },
        classify: { kind: "method" },
        onExtracted: { kind: "result" },
      });
      const json = JSON.stringify(record.config);
      expect(json).not.toContain(PDF_MARKER); // no pdf bytes
      expect(json).not.toContain('"x0"'); // no bbox — own or foreign
      expect(json).not.toContain(FAKE_PROVIDER_KEY); // no credential material
    }
  });

  it("mounts only the PENDING regions once some are completed", () => {
    const { ports } = makePorts();
    const state: ParsePmState = {
      ...atExtract(),
      completed: {
        title: { text: "t", label: "heading", costUsd: 0.009 },
        authors: { text: "a", label: "byline", costUsd: 0.008 },
      },
    };
    const subagents = mountRecords(createStore(state), ports).filter(
      (r) => r.kind === "subagent",
    );
    expect(subagents.map((r) => r.name)).toEqual([
      "extract:abstract-left",
      "extract:intro-left",
    ]);
  });

  it("mounts nothing but the top-up gate at paused, and nothing at done", () => {
    const { ports } = makePorts();
    const paused = mountRecords(
      createStore<ParsePmState>({ ...atExtract(0.025), goal: { phase: "paused" } }),
      ports,
    );
    expect(paused.filter((r) => r.kind === "subagent")).toEqual([]);
    expect(paused.filter((r) => r.kind === "task").map((r) => r.name)).toEqual([
      "topup-gate:0.025",
    ]);

    const done = mountRecords(
      createStore<ParsePmState>({ ...atExtract(), goal: { phase: "done" } }),
      ports,
    );
    expect(done.filter((r) => r.kind === "subagent" || r.kind === "task")).toEqual([]);
  });

  it("readRegion is pre-bound to its own region — the slice IS the golden text", () => {
    const { ports } = makePorts();
    const subagents = mountRecords(createStore(atExtract()), ports).filter(
      (r) => r.kind === "subagent",
    );
    for (const record of subagents) {
      const slice = record.handlers.readRegion?.();
      expect(slice).toBe(goldenText.get(String(record.config.regionId))!);
    }
  });
});

describe("parse-pm checkbook — refusal at the exact region boundary", () => {
  it("affords title+authors, refuses abstract-left, parks at paused with a checkpoint", async () => {
    const events: string[] = [];
    const { ports, provider } = makePorts(REGIONS, events);
    const result = await drive(startState(0.025), ports);
    const state = result.state;

    expect(state.goal).toEqual({ phase: "paused" });
    expect(Object.keys(state.completed)).toEqual(["title", "authors"]);
    expect(state.spentUsd).toBe(0.017);
    expect(state.callCount).toBe(2);
    expect(provider.calls.map((call) => call.regionId)).toEqual(["title", "authors"]);
    expect(state.refusals).toEqual([
      { regionId: "abstract-left", ceilingUsd: 0.01, remainingUsd: 0.008 },
    ]);
    // The checkpoint records exactly which work is paid for.
    expect(state.checkpoint).toMatchObject({
      seq: 3,
      phase: "extract",
      reason: "budget-refused",
      regionId: "abstract-left",
      completedRegions: ["title", "authors"],
      spentUsd: 0.017,
      callCount: 2,
    });
    expect(Object.keys(state.checkpoint!.results)).toEqual(["title", "authors"]);
    // The refusal is an attributed transition, not an exception.
    expect(state.log.at(-1)).toMatchObject({
      outcome: "budget_exhausted",
      source: { phase: "extract", child: "extractor:abstract-left" },
      from: "extract",
      to: "paused",
      changed: true,
    });
  });

  it("persists the checkpoint BEFORE each provider call commits (event-order oracle)", async () => {
    const events: string[] = [];
    const { ports } = makePorts(REGIONS, events);
    await drive(startState(0.025), ports);
    expect(events).toEqual([
      "persist:1",
      "call:title",
      "persist:2",
      "call:authors",
      "persist:3", // the refusal checkpoint — no call follows it
    ]);
  });
});

describe("parse-pm resume — completed regions are never re-bought", () => {
  it("tops up, resumes from the checkpoint, and finishes with exactly two more calls", async () => {
    const first = makePorts();
    const paused = (await drive(startState(0.025), first.ports)).state;

    const second = makePorts();
    const resumed = await drive(
      { ...paused, budgetUsd: usd(paused.budgetUsd + 0.025) },
      second.ports,
    );
    const state = resumed.state;

    expect(state.goal).toEqual({ phase: "done" });
    expect(second.provider.calls.map((call) => call.regionId)).toEqual([
      "abstract-left",
      "intro-left",
    ]);
    expect(state.callCount).toBe(4);
    expect(state.spentUsd).toBe(0.03);
    // The durable ledger is the call-count oracle: four calls, no duplicates.
    expect(state.ledger.map((entry) => entry.regionId)).toEqual([
      "title",
      "authors",
      "abstract-left",
      "intro-left",
    ]);
    // Only pending regions were played on resume.
    expect(resumed.played.map((child) => child.name)).toEqual([
      "extract:abstract-left",
      "extract:intro-left",
    ]);
    expect(state.verified).toEqual({ ok: true, mismatches: [] });
  });

  it("replays deterministically from the JSON round-trip of the paused checkpointed state", async () => {
    const paused = (await drive(startState(0.025), makePorts().ports)).state;
    const topped = { ...paused, budgetUsd: usd(paused.budgetUsd + 0.025) };

    const fromMemory = await drive(topped, makePorts().ports);
    const fromDisk = await drive(
      JSON.parse(JSON.stringify(topped)) as ParsePmState,
      makePorts().ports,
    );
    expect(JSON.stringify(fromDisk.state)).toBe(JSON.stringify(fromMemory.state));
    expect(fromDisk.state.goal).toEqual({ phase: "done" });
  });
});

describe("parse-pm privacy — the audit trail of everything that crossed", () => {
  it("no played child ever received pdf bytes, a bbox, or credential material", async () => {
    const { ports } = makePorts();
    const paused = await drive(startState(0.025), ports);
    const resumed = await drive(
      { ...paused.state, budgetUsd: 0.05 },
      makePorts().ports,
    );
    const everyPlay = [...paused.played, ...resumed.played];
    expect(everyPlay.length).toBeGreaterThanOrEqual(4);
    for (const child of everyPlay) {
      expect(Object.keys(child.config)).toEqual(["regionId"]);
      expect(child.bindings).toEqual({
        readRegion: "method",
        classify: "method",
        onExtracted: "result",
      });
      const json = JSON.stringify(child);
      expect(json).not.toContain(PDF_MARKER);
      expect(json).not.toContain('"x0"');
      expect(json).not.toContain(FAKE_PROVIDER_KEY);
    }
  });

  it("the doc never enters durable state — only its byte count does", async () => {
    const { ports } = makePorts();
    const result = await drive(startState(0.05), ports);
    const json = JSON.stringify(result.state);
    expect(result.state.docBytes).toBe(SAMPLE_PDF_B64.length);
    expect(json).not.toContain(PDF_MARKER);
    expect(json).not.toContain(FAKE_PROVIDER_KEY);
  });
});

describe("parse-pm oracle — segments at verify deep-equal golden, and it bites", () => {
  it("a straight run assembles the golden segments in region order", async () => {
    const { ports } = makePorts();
    const state = (await drive(startState(0.05), ports)).state;
    expect(state.goal).toEqual({ phase: "done" });
    expect(state.verified).toEqual({ ok: true, mismatches: [] });
    expect(state.assembled!.map(({ id, text }) => ({ id, text }))).toEqual(
      GOLDEN.map(({ id, text }) => ({ id, text })),
    );
  });

  it("a shifted bbox cannot reproduce the golden (the attenuated slice is faithful)", async () => {
    const shifted = REGIONS.map((region) =>
      region.id === "abstract-left"
        ? {
            ...region,
            bbox: { ...region.bbox, y0: region.bbox.y0 + 0.2, y1: region.bbox.y1 + 0.2 },
          }
        : region,
    );
    const { ports } = makePorts(shifted);
    const state = (await drive(startState(0.05), ports)).state;
    // The run is internally consistent (verify re-extracts the SAME slices)…
    expect(state.verified!.ok).toBe(true);
    // …but the external oracle refuses it: the abstract segment is wrong.
    const abstract = state.assembled!.find((segment) => segment.id === "abstract-left")!;
    expect(abstract.text).not.toBe(goldenText.get("abstract-left")!);
  });
});

describe("parse-pm staleness — a late grant cannot corrupt machine or money", () => {
  /** Render the provider once against a live store, keeping the minted grants
   *  and records, exactly as a host would hold them. */
  const mountOnce = () => {
    const { ports, provider } = makePorts();
    const store = createStore<ParsePmState>(atExtract(0.025));
    const grants = new Map<string, GoalDispatch>();
    const transitions: GoalTransition[] = [];
    const onTransition = (transition: GoalTransition) => {
      recordParseTransition(store)(transition);
      transitions.push(transition);
    };
    const render = () =>
      evaluateTree(
        <GoalProvider table={PARSE_GOAL_TABLE} store={store} onTransition={onTransition}>
          {declareParseGoal(store, ports, grants)}
        </GoalProvider>,
      ).flatMap((root) => collectInfra(root));
    return { store, grants, transitions, render, provider };
  };

  it("refuses a replayed raw grant from a left phase as stale", () => {
    const { store, grants, transitions, render } = mountOnce();
    render(); // mint the extract grants
    grants.get("extract/extractor:abstract-left")!("budget_exhausted");
    expect(store.get().goal).toEqual({ phase: "paused" });

    // The title grant — minted for the extract phase — fires again, late.
    grants.get("extract/extractor:title")!("extracted");
    expect(transitions.at(-1)).toMatchObject({
      outcome: "extracted",
      source: { phase: "extract", child: "extractor:title" },
      from: "paused",
      changed: false,
      ignored: "stale",
    });
    expect(store.get().goal).toEqual({ phase: "paused" });
    // The refusal is part of the durable attributed log.
    expect(store.get().log.at(-1)).toMatchObject({ ignored: "stale", changed: false });
  });

  it("a late completion report folds nothing and lands stale (the chess out-of-turn pattern)", () => {
    const { store, grants, render } = mountOnce();
    const title = render().find((r) => r.name === "extract:title")!;
    grants.get("extract/extractor:abstract-left")!("budget_exhausted");

    title.handlers.onExtracted?.({ regionId: "title", text: "late", label: "late", costUsd: 0 });
    expect(store.get().completed.title).toBeUndefined(); // nothing folded
    expect(store.get().log.at(-1)).toMatchObject({
      outcome: "extracted",
      source: { phase: "extract", child: "extractor:title" },
      ignored: "stale",
      changed: false,
    });
  });

  it("the classify capability self-expires: a stale grant cannot spend the checkbook", () => {
    const { store, grants, render, provider } = mountOnce();
    const title = render().find((r) => r.name === "extract:title")!;
    grants.get("extract/extractor:abstract-left")!("budget_exhausted");
    expect(store.get().goal).toEqual({ phase: "paused" });

    const outcome = title.handlers.classify?.("some text");
    expect(outcome).toEqual({ ok: false, refused: "stale_grant" });
    expect(provider.calls).toEqual([]); // the provider was never reached
    expect(store.get().spentUsd).toBe(0); // not a cent moved
    expect(store.get().checkpoint).toBeNull(); // no checkpoint noise either
  });
});

describe("parse-pm under the live SimHost reconciler", () => {
  it("runs the whole plan phase by phase to done, creating every record exactly once", () => {
    const { ports, provider } = makePorts();
    const world: World = {
      statusAt: () => 200,
      subagentLatency: 1,
      subagentResult: (record) => playRegionExtractor(record),
    };
    const host = new SimHost(world);
    const store = createStore<ParsePmState>(startState(0.05));
    const agent = mountAgent(<ParseAgent.spec.impl store={store} ports={ports} />, host, {
      quiet: true,
    });

    for (let t = 1; t <= 8; t += 1) agent.tick();

    const state = store.get();
    expect(state.goal).toEqual({ phase: "done" });
    expect(provider.calls).toHaveLength(4);
    expect(state.assembled!.map(({ id, text }) => ({ id, text }))).toEqual(
      GOLDEN.map(({ id, text }) => ({ id, text })),
    );
    expect(
      state.log
        .filter((entry) => entry.changed)
        .map((entry) => `${entry.source.phase} ${entry.outcome} ▶ ${entry.to}`),
    ).toEqual([
      "ingest ingested ▶ layout",
      "layout layouted ▶ extract",
      "extract extracted ▶ assemble",
      "assemble assembled ▶ verify",
      "verify verified ▶ done",
    ]);
    const creates = host.opLog
      .filter((op) => op.op === "create")
      .map((op) => `${op.kind}:${op.name}`);
    expect(new Set(creates).size).toBe(creates.length); // never created twice
    expect([...host.liveRecords.values()].filter((r) => r.kind === "subagent")).toEqual([]);
    agent.unmount();
  });

  it("pauses mid-extract under the reconciler too, then resumes after a live top-up", () => {
    const { ports, provider } = makePorts();
    const world: World = {
      statusAt: () => 200,
      subagentLatency: 1,
      subagentResult: (record) => playRegionExtractor(record),
    };
    const host = new SimHost(world);
    const store = createStore<ParsePmState>(startState(0.025));
    const agent = mountAgent(<ParseAgent.spec.impl store={store} ports={ports} />, host, {
      quiet: true,
    });

    for (let t = 1; t <= 4; t += 1) agent.tick();
    expect(store.get().goal).toEqual({ phase: "paused" });
    expect(provider.calls.map((call) => call.regionId)).toEqual(["title", "authors"]);

    agent.dispatch(() => applyTopUp(store, 0.025));
    for (let t = 1; t <= 5; t += 1) agent.tick();

    expect(store.get().goal).toEqual({ phase: "done" });
    expect(provider.calls.map((call) => call.regionId)).toEqual([
      "title",
      "authors",
      "abstract-left",
      "intro-left",
    ]);
    agent.unmount();
  });
});
