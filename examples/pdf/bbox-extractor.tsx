/**
 * The React description of the Phase A child: a bbox extractor agent.
 *
 * Everything the hand-written BboxExtractorDurable does imperatively is a
 * prop or an intrinsic here:
 *   - getPdf   — v0.6 METHOD PROP: pull the bytes from the parent on demand
 *                (the pdf is never pushed into child props).
 *   - <task>   — the one-shot work intrinsic this phase adds: run once on
 *                mount (per stable name), deliver the result to onDone.
 *   - onSegment — callback prop: the extracted text flows back to the parent.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { b64ToBytes, extractTextLayer, type Bbox } from "../../targets/pdf/core/extract.ts";

export interface BboxExtractorProps {
  regionId: string;
  bbox: Bbox;
  getPdf: () => string | Promise<string>;
  onSegment: (regionId: string, text: string) => void;
}

export interface BboxExtractorState extends Record<string, unknown> {
  extracted: string | null;
}

export const BboxExtractor = agentComponent<BboxExtractorProps, BboxExtractorState>({
  agentName: "bbox-extractor",
  initialState: { extracted: null },
  capabilities: {
    getPdf: { kind: "method" },
    onSegment: { kind: "callback" },
  },
  sampleProps: {
    regionId: "sample",
    bbox: { x0: 0, y0: 0, x1: 1, y1: 1 },
    getPdf: () => "",
    onSegment: () => {},
  },
  impl: ({ regionId, bbox, getPdf, onSegment, store }) => {
    const { extracted } = useAgentState(store);
    return (
      <>
        {!extracted && (
          <task
            name={`extract:${regionId}`}
            run={async () => extractTextLayer(b64ToBytes(await getPdf()), bbox)}
            onDone={(text) => {
              store.set({ extracted: regionId });
              onSegment(regionId, String(text));
            }}
          />
        )}
        <prompt>
          <sys p={10}>
            You extract the text layer of ONE region ({regionId}) of a PDF page.
          </sys>
          <msg p={7}>{extracted ? `extracted ${regionId}.` : "extraction pending."}</msg>
        </prompt>
      </>
    );
  },
});
