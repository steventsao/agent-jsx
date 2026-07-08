/**
 * Static/dynamic split by partial evaluation: evaluate the component at
 * several sample states; records present in EVERY sample are static
 * (deploy-time infrastructure), the rest are dynamic (state-gated — they
 * mount and unmount as the agent runs).
 *
 * Continuation grandchildren are a SECOND dynamic axis. A boundary's render-prop
 * `children` expand only from an emitted output, which is absent at rest — so
 * they never appear in the base (no-expansion) evaluation. We surface them by
 * re-evaluating each sample with sample-output expansion on, and append the
 * extras to `dynamic`: continuation-produced boundaries are output-gated, hence
 * DYNAMIC by definition, and are never promoted to static.
 */

import type { ReactNode } from "react";
import { collectInfra } from "../tree.ts";
import { withOutputs } from "../store.ts";
import type { InfraRecord } from "../types.ts";
import { evaluateTree } from "./evaluate.ts";

export interface Analysis {
  static: InfraRecord[];
  dynamic: InfraRecord[]; // union of records seen in some-but-not-all samples
}

/** Collect one sample's infra records, keyed by identity, with continuation
 *  expansion on or off (off = base state-gated split; on = surface grandchildren). */
function collectSample(element: ReactNode, expandSamples: boolean): Map<string, InfraRecord> {
  const records = new Map<string, InfraRecord>();
  withOutputs({ outputs: {}, setOutput: () => {}, expandSamples }, () => {
    for (const root of evaluateTree(element))
      for (const rec of collectInfra(root)) records.set(`${rec.kind}:${rec.name}`, rec);
  });
  return records;
}

export function analyze(renderAt: (sample: number) => ReactNode, samples: number): Analysis {
  const perSample: Map<string, InfraRecord>[] = [];
  for (let i = 0; i < samples; i++) perSample.push(collectSample(renderAt(i), false));

  const universe = new Map<string, InfraRecord>();
  for (const sample of perSample) for (const [k, v] of sample) universe.set(k, v);

  const analysis: Analysis = { static: [], dynamic: [] };
  for (const [k, rec] of universe) {
    (perSample.every((s) => s.has(k)) ? analysis.static : analysis.dynamic).push(rec);
  }

  // Second axis: continuation grandchildren, surfaced by sample-output
  // expansion. Anything not already classified is an output-gated boundary → dynamic.
  const seen = new Set([...analysis.static, ...analysis.dynamic].map((r) => `${r.kind}:${r.name}`));
  for (let i = 0; i < samples; i++) {
    for (const [k, rec] of collectSample(renderAt(i), true)) {
      if (!seen.has(k)) {
        seen.add(k);
        analysis.dynamic.push(rec);
      }
    }
  }
  return analysis;
}
