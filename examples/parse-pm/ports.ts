/**
 * The ParseAgent PM's equipment — every seam between the composition and the
 * world, as ONE typed ports object the environment hands the root.
 *
 * The split matters for all three requirements:
 *
 *   BUDGET   `model` is the only path to a provider. The PM's classify grant
 *            (minted in parse-agent.tsx) meters spend from the provider's OWN
 *            usage fields and refuses calls that would overdraw — children
 *            never see this object, so they can never hold the checkbook or
 *            the credential behind it.
 *   PRIVACY  `pageItems` yields the parsed source doc to the PARENT only; the
 *            per-region capability a child receives is a zero-arg closure the
 *            parent pre-binds over one bbox (see readRegion in parse-agent).
 *            The doc itself lives in PM-owned storage (DO storage in the
 *            worker, a module holder in the sim) — never in state, never in
 *            child props.
 *   CHECKPOINT `persist` is the durable write barrier: when it resolves, the
 *            state it was handed must survive process death. The classify
 *            grant calls it BEFORE every metered call commits (the CF
 *            "checkpoint before expensive work" rule).
 *
 * Everything here is sync-OR-async on purpose: the sim wires sync ports so a
 * SimHost world can play children synchronously; the worker wires async ones
 * (storage, fetch). `chain` lets one closure serve both without forcing every
 * runtime through promises.
 */

import type { PositionedItem } from "../pdf/core/extract.ts";
import type { Region } from "../../fixtures/pdf/regions.ts";

export type { Region };

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  /** REAL cost in USD as reported by the provider (OpenRouter `usage.cost`).
   *  The PM meters spend from this field — never from its own guesses. */
  costUsd: number;
}

export interface RegionClassification {
  label: string;
  usage: ModelUsage;
}

/**
 * The provider seam. The worker env implements it live (model-runtime.ts reads
 * `env.OPENROUTER_API_KEY` — a binding by NAME; no value ever appears in code
 * or tests); tests and the demo use `fakeProvider` with scripted usage.
 */
export interface ModelProvider {
  /** Flat per-call ceiling the PM debits against BEFORE calling. A call is
   *  refused when `spent + maxCallCostUsd > budget` — the checkbook never
   *  discovers an overdraft after the fact. */
  readonly maxCallCostUsd: number;
  classifyRegion(input: {
    regionId: string;
    text: string;
  }): RegionClassification | Promise<RegionClassification>;
}

export interface ParsePorts {
  /** Ensure the source doc is present in PM-OWNED storage (never state);
   *  resolve its size. The worker writes DO storage; the sim uses a holder. */
  ingest: () => { bytes: number } | Promise<{ bytes: number }>;
  /** The layout step — fixture-driven regions ("what the layoutparser said");
   *  a live VLM is a later swap that must not touch extraction. */
  layout: () => Region[] | Promise<Region[]>;
  /** The parsed text items of the source doc, PARENT-side only. Sync by
   *  contract: each runtime parses once up front (top-level await in the sim,
   *  a per-instance cache in the worker) so region slices and world transports
   *  stay synchronous. */
  pageItems: () => PositionedItem[];
  /** The metered provider. */
  model: ModelProvider;
  /** Durable write barrier: state handed here survives process death once the
   *  call resolves. Called BEFORE every metered call commits. */
  persist: (state: Record<string, unknown>) => void | Promise<void>;
}

/** Chain a sync-or-async value without forcing the sync path through a
 *  microtask — the reason one classify closure serves both the SimHost world
 *  (sync) and the worker (async). */
export function chain<T, R>(
  value: T | Promise<T>,
  next: (v: T) => R | Promise<R>,
): R | Promise<R> {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as Promise<T>).then === "function"
    ? (value as Promise<T>).then(next)
    : next(value as T);
}

/** Money arithmetic at a fixed precision (micro-USD) so scripted runs fold to
 *  byte-identical JSON — float drift would break replay determinism. */
export const usd = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Inert ports for building the goal table / sampleProps: the phase graph must
 *  not depend on live equipment (declareGoalTable evaluates with these). */
export function inertPorts(): ParsePorts {
  return {
    ingest: () => ({ bytes: 0 }),
    layout: () => [],
    pageItems: () => [],
    model: {
      maxCallCostUsd: 0,
      classifyRegion: () => ({
        label: "",
        usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
      }),
    },
    persist: () => {},
  };
}
