/**
 * Static/dynamic split by partial evaluation: evaluate the component at
 * several sample states; records present in EVERY sample are static
 * (deploy-time infrastructure), the rest are dynamic (state-gated — they
 * mount and unmount as the agent runs).
 */

import type { ReactNode } from "react";
import { collectInfra } from "../tree.ts";
import type { InfraRecord } from "../types.ts";
import { evaluateTree } from "./evaluate.ts";

export interface Analysis {
  static: InfraRecord[];
  dynamic: InfraRecord[]; // union of records seen in some-but-not-all samples
}

export function analyze(renderAt: (sample: number) => ReactNode, samples: number): Analysis {
  const perSample: Map<string, InfraRecord>[] = [];
  for (let i = 0; i < samples; i++) {
    const records = new Map<string, InfraRecord>();
    for (const root of evaluateTree(renderAt(i)))
      for (const rec of collectInfra(root)) records.set(`${rec.kind}:${rec.name}`, rec);
    perSample.push(records);
  }

  const universe = new Map<string, InfraRecord>();
  for (const sample of perSample) for (const [k, v] of sample) universe.set(k, v);

  const analysis: Analysis = { static: [], dynamic: [] };
  for (const [k, rec] of universe) {
    (perSample.every((s) => s.has(k)) ? analysis.static : analysis.dynamic).push(rec);
  }
  return analysis;
}
