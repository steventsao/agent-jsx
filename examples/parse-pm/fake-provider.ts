/**
 * The scripted provider — deterministic usage numbers, an in-memory call log
 * (the call-count oracle), and a DECOY credential.
 *
 * The decoy exists so privacy tests can assert credential material never
 * reaches a child: the provider closes over `FAKE_PROVIDER_KEY` exactly the
 * way the live OpenRouter provider closes over `env.OPENROUTER_API_KEY`, and
 * tests grep every child config/state for it. It is not a real key and never
 * leaves this process.
 *
 * Costs are per-region and ≤ `maxCallCostUsd` (the flat ceiling the PM debits
 * against BEFORE a call), so the scripted budget arithmetic is exact:
 *
 *   budget 0.025 → title (0.009) ✓, authors (0.008) ✓ [spent 0.017],
 *   abstract-left: remaining 0.008 < ceiling 0.010 → REFUSED → paused.
 *   top-up +0.025 → abstract-left (0.007), intro-left (0.006) → spent 0.030.
 */

import type { ModelProvider, RegionClassification } from "./ports.ts";

/** Decoy credential — grep target for privacy assertions, never a real value. */
export const FAKE_PROVIDER_KEY = "sk-or-fake-parse-pm-do-not-use";

export const FAKE_MAX_CALL_COST_USD = 0.01;

export const FAKE_REGION_COSTS: Record<string, number> = {
  title: 0.009,
  authors: 0.008,
  "abstract-left": 0.007,
  "intro-left": 0.006,
};

export const FAKE_REGION_LABELS: Record<string, string> = {
  title: "heading",
  authors: "byline",
  "abstract-left": "abstract",
  "intro-left": "body-text",
};

export interface FakeProvider extends ModelProvider {
  /** Every classifyRegion invocation, in order — the call-count oracle. */
  readonly calls: Array<{ regionId: string; textChars: number }>;
}

export function fakeProvider(
  overrides: {
    costs?: Record<string, number>;
    labels?: Record<string, string>;
    maxCallCostUsd?: number;
  } = {},
): FakeProvider {
  const costs = overrides.costs ?? FAKE_REGION_COSTS;
  const labels = overrides.labels ?? FAKE_REGION_LABELS;
  const calls: Array<{ regionId: string; textChars: number }> = [];
  // The decoy credential is CLOSED OVER, mirroring how the live provider holds
  // its key: reachable from the classify capability, invisible to children.
  const credential = FAKE_PROVIDER_KEY;
  return {
    calls,
    maxCallCostUsd: overrides.maxCallCostUsd ?? FAKE_MAX_CALL_COST_USD,
    classifyRegion({ regionId, text }): RegionClassification {
      if (!credential) throw new Error("fake provider lost its decoy key");
      calls.push({ regionId, textChars: text.length });
      return {
        label: labels[regionId] ?? "text",
        usage: {
          promptTokens: text.length,
          completionTokens: 4,
          costUsd: costs[regionId] ?? 0.005,
        },
      };
    },
  };
}
