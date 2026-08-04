/**
 * Receipt cascade (examples/receipt) — the VLM+OCR composition contract,
 * driven end-to-end in SimHost with a deterministic subagent transport.
 *
 * Pinned claims:
 *  1. GATING — the layout agent mounts alone; region specialists mount only
 *     after its result lands (cascade, not a static fan-out).
 *  2. TAG DISPATCH — `table` regions get table-parser, `text` get ocr-text,
 *     `figure` regions mount NOTHING, ever.
 *  3. ATTENUATION — a specialist's `crop` capability yields only its own
 *     region's pixels; no child config ever contains the page bytes (the
 *     capability-pull contract from PDF-PIPELINE, narrowed per region).
 *  4. ASSEMBLY — deterministic code (a one-shot <task>) folds specialist
 *     results into the golden receipt; extra ticks change nothing and no
 *     record is ever created twice.
 */

import { describe, expect, it } from "bun:test";
import { mountAgent } from "../src/agent.ts";
import { SimHost, type World } from "../src/sim-host.ts";
import { createStore } from "../src/state.ts";
import type { InfraRecord } from "../src/types.ts";
import {
  bboxKey,
  initialReceiptState,
  ReceiptPipeline,
  type Bbox,
  type Receipt,
  type ReceiptEngines,
  type ReceiptState,
  type Region,
} from "../examples/receipt/receipt-pipeline.tsx";

// ---------------------------------------------------------------------------
// Fixture: the "scanned page" is a JSON map of bbox → pixel content.

const B = {
  header: { x0: 0, y0: 0, x1: 1, y1: 0.2 } satisfies Bbox,
  items: { x0: 0, y0: 0.2, x1: 1, y1: 0.7 } satisfies Bbox,
  total: { x0: 0, y0: 0.7, x1: 1, y1: 0.85 } satisfies Bbox,
  logo: { x0: 0, y0: 0.85, x1: 1, y1: 1 } satisfies Bbox,
};

const PAGE = JSON.stringify({
  [bboxKey(B.header)]: "BLUE BOTTLE COFFEE",
  [bboxKey(B.items)]: "TABLE:Latte|4.50;Beans|10.00",
  [bboxKey(B.total)]: "TOTAL $14.50",
  [bboxKey(B.logo)]: "LOGO",
});

/** Deterministic engines — honest functions of their inputs only, swappable
 *  for live models without touching the composition. */
const engines: ReceiptEngines = {
  layout: (page) =>
    Object.entries(JSON.parse(page) as Record<string, string>).map(([key, content], i): Region => {
      const [x0, y0, x1, y1] = key.split(",").map(Number) as [number, number, number, number];
      const tag = content.startsWith("TABLE:") ? "table" : content === "LOGO" ? "figure" : "text";
      return { id: `r${i}`, tag, bbox: { x0, y0, x1, y1 } };
    }),
  ocr: (crop) => crop,
  table: (crop) =>
    crop
      .replace(/^TABLE:/, "")
      .split(";")
      .map((row) => row.split("|")),
};

const GOLDEN: Receipt = {
  merchant: "BLUE BOTTLE COFFEE",
  total: "$14.50",
  items: [
    ["Latte", "4.50"],
    ["Beans", "10.00"],
  ],
};

// ---------------------------------------------------------------------------
// Deterministic subagent transport: plays each child's runtime by invoking the
// capabilities the boundary actually granted (record.handlers) — the sim
// analog of the generated child pulling through its CallbackRef proxies.

interface SeenChild {
  config: Record<string, unknown>;
  cropped?: string;
}

function makeWorld(seen: Map<string, SeenChild>): World {
  return {
    statusAt: () => 200,
    subagentLatency: 1,
    subagentResult: (record: InfraRecord) => {
      const kind = String(record.config.kind);
      const entry: SeenChild = { config: { ...record.config } };
      seen.set(record.name, entry);
      if (kind === "layout-parser") {
        const page = record.handlers.getPage?.() as string;
        return record.handlers.parseLayout?.(page);
      }
      if (kind === "ocr-text") {
        entry.cropped = record.handlers.crop?.() as string;
        return {
          regionId: record.config.regionId,
          text: record.handlers.ocr?.(entry.cropped),
        };
      }
      if (kind === "table-parser") {
        entry.cropped = record.handlers.crop?.() as string;
        return {
          regionId: record.config.regionId,
          rows: record.handlers.parseTable?.(entry.cropped),
        };
      }
      throw new Error(`unexpected child kind ${kind}`);
    },
  };
}

function run(ticks: number, eng: ReceiptEngines = engines) {
  const seen = new Map<string, SeenChild>();
  const host = new SimHost(makeWorld(seen));
  const store = createStore<ReceiptState>({ ...initialReceiptState, page: PAGE });
  const agent = mountAgent(<ReceiptPipeline store={store} engines={eng} />, host, { quiet: true });
  for (let i = 0; i < ticks; i += 1) agent.tick();
  return { host, store, agent, seen };
}

const createsOf = (host: SimHost) =>
  host.opLog.filter((op) => op.op === "create").map((op) => `${op.kind}:${op.name}`);

describe("receipt cascade — gating and tag dispatch", () => {
  it("mounts ONLY the layout agent until its result lands", () => {
    const { host, agent } = run(0);
    expect(createsOf(host)).toEqual(["subagent:layout:main"]);
    agent.unmount();
  });

  it("dispatches by tag after layout: table→table-parser, text→ocr-text, figure→nothing", () => {
    const { host, store, agent } = run(1); // layout completes at t=1
    expect(store.get().regions).toHaveLength(4);
    const creates = createsOf(host);
    expect(creates).toContain("subagent:ocr:r0");
    expect(creates).toContain("subagent:table:r1");
    expect(creates).toContain("subagent:ocr:r2");
    // The figure region mounts no specialist of any kind.
    expect(creates.filter((c) => c.includes("r3"))).toEqual([]);
    agent.unmount();
  });
});

describe("receipt cascade — capability attenuation", () => {
  it("each specialist's crop yields ONLY its own region's pixels", () => {
    const { seen, agent } = run(2);
    expect(seen.get("ocr:r0")?.cropped).toBe("BLUE BOTTLE COFFEE");
    expect(seen.get("table:r1")?.cropped).toBe("TABLE:Latte|4.50;Beans|10.00");
    expect(seen.get("ocr:r2")?.cropped).toBe("TOTAL $14.50");
    agent.unmount();
  });

  it("no child input ever contains the page bytes — children pull, never receive", () => {
    const { seen, agent } = run(3);
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const [, child] of seen) {
      expect(JSON.stringify(child.config)).not.toContain("BLUE BOTTLE");
      expect(JSON.stringify(child.config)).not.toContain("TABLE:");
    }
    agent.unmount();
  });
});

describe("receipt cascade — deterministic assembly", () => {
  it("folds specialist results into the golden receipt via a one-shot <task>", () => {
    const { store, agent } = run(4); // t1 layout, t2 specialists, t3 assemble task
    expect(store.get().receipt).toEqual(GOLDEN);
    agent.unmount();
  });

  it("the oracle bites: a mis-cropped region cannot reproduce golden", () => {
    // Layout mislocates the total region onto the logo's bbox — the attenuated
    // crop faithfully yields the WRONG pixels, so assembly must not find TOTAL.
    const badLayout: ReceiptEngines = {
      ...engines,
      layout: (page) =>
        engines.layout(page).map((r) => (r.id === "r2" ? { ...r, bbox: B.logo } : r)),
    };
    const { store, agent } = run(6, badLayout);
    expect(store.get().receipt).not.toEqual(GOLDEN);
    expect(store.get().receipt?.total).toBe("");
    agent.unmount();
  });

  it("is idempotent: extra ticks re-run nothing and re-create nothing", () => {
    const { host, store, agent } = run(8);
    expect(store.get().receipt).toEqual(GOLDEN);
    const creates = createsOf(host);
    expect(new Set(creates).size).toBe(creates.length); // every record created exactly once
    agent.unmount();
  });
});
