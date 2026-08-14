/**
 * The per-region extractor — a deliberately DUMB child. Its whole world is
 * three grants, and every one is attenuated at the composition site:
 *
 *   readRegion   ZERO-ARG method prop. The parent pre-binds the region's bbox
 *                (the receipt/PDF crop pattern), so this child cannot address
 *                a byte outside its own region — and never sees the doc, the
 *                bbox, or any sibling's slice. Extraction itself stays the
 *                deterministic unpdf spec, run where the doc lives.
 *   classify     PM-mediated, METERED model call. The closure is the parent's
 *                checkbook: it checkpoints, debits the ceiling, and may REFUSE
 *                (`{ ok: false }`). The child never holds provider credentials
 *                or budget state — that is half the privacy requirement.
 *   onExtracted  The one result binding: report `{regionId, text, label}` back.
 *
 * Serializable input is `regionId` alone. No pdf bytes, no bbox, no budget —
 * the privacy tests grep exactly this config.
 *
 * Authored shape: one PascalCase function component plus the explicit
 * `profile` beside it. The compiler-owned companion at
 * ./generated/region-extractor.compiled.tsx (emitted by ./generate.tsx)
 * exposes the boundary under the same public JSX name.
 */

import { defineAgentProfile, type AgentRenderProps } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";

/** What the checkbook resolves a classify request to. Refusal is DATA, not an
 *  exception: budget exhaustion is a phase, and a refused child simply has no
 *  report to file. */
export type ClassifyOutcome =
  | { ok: true; label: string; costUsd: number }
  | { ok: false; refused: "budget_exhausted" | "stale_grant" };

export interface RegionReport {
  regionId: string;
  text: string;
  label: string;
  costUsd: number;
}

export interface RegionExtractorProps {
  regionId: string;
  /** Zero-arg, parent-bound: THIS region's text layer, nothing else. */
  readRegion: () => string | Promise<string>;
  /** PM-mediated metered model call; the checkbook may refuse it. */
  classify: (text: string) => ClassifyOutcome | Promise<ClassifyOutcome>;
  onExtracted: (report: RegionReport) => void;
}

export interface RegionExtractorState extends Record<string, unknown> {
  reported: boolean;
}

/** Identity, state, and authority stay explicit; only boundary glue is generated. */
export const profile = defineAgentProfile<RegionExtractorProps, RegionExtractorState>({
  name: "region-extractor",
  description:
    "Extracts ONE region's text layer through a pre-bound slice grant, labels it through the PM's metered model capability, and reports back.",
  initialState: { reported: false },
  sampleProps: {
    regionId: "sample",
    readRegion: () => "",
    classify: () => ({ ok: false, refused: "budget_exhausted" }),
    onExtracted: () => {},
  },
  capabilities: {
    readRegion: "method",
    classify: "method",
    onExtracted: "result",
  },
});

/** A normal pure JSX component. The compiler, not this file, makes it a boundary. */
export default function RegionExtractor({
  regionId,
  store,
}: AgentRenderProps<RegionExtractorProps, RegionExtractorState>) {
  const state = useAgentState(store);
  return (
    <prompt>
      <sys p={10}>
        You extract and label the text layer of ONE region ({regionId}) of a
        document. You pull your slice through your readRegion grant and label
        it through the project manager's metered classify grant.
      </sys>
      <msg p={7}>{state.reported ? `reported ${regionId}.` : "work pending."}</msg>
    </prompt>
  );
}
