/**
 * Shared PDF domain primitive: text-layer extraction within a bbox.
 *
 * REACT-FREE and runtime-portable (bun for fixtures/tests, workerd inside
 * child DOs via unpdf — pdf.js built for serverless). This single
 * implementation is shared by the fixture generator, the hand-written
 * targets, and the compiled components, so "golden" means: every deploy
 * target reproduces this reference behavior in ITS environment.
 *
 * Bbox convention (ours, fixed): normalized page coordinates, TOP-LEFT
 * origin, { x0, y0, x1, y1 } with 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1.
 * (PDF-native coords are bottom-left; the conversion happens here, once.)
 *
 * Membership rule: a text item belongs to a bbox iff its CENTER falls inside.
 * Reading order: top-to-bottom bands, then left-to-right. Whitespace
 * collapsed. Page 1 only (ParseBench samples are single pages).
 */

import { getDocumentProxy } from "unpdf";

// pdf.js' serverless build runs a SAME-THREAD fake worker whose LoopbackPort
// defensively structuredClone()s every message. Bun's structuredClone (esp.
// under `bun test`) throws DataCloneError on payloads Node and workerd clone
// fine; since the port is same-realm, identity is a safe fallback THERE.
// Guarded to bun so workerd/production keep native behavior. (COMPAT-REPORT)
if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
  const native = globalThis.structuredClone.bind(globalThis);
  globalThis.structuredClone = ((value: unknown, opts?: unknown) => {
    try {
      return native(value as never, opts as never);
    } catch {
      return value;
    }
  }) as typeof structuredClone;
}

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PositionedItem {
  str: string;
  /** normalized top-left coords of the item's box */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RawTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export async function pageTextItems(pdfBytes: Uint8Array): Promise<PositionedItem[]> {
  // pdf.js TRANSFERS (detaches) the buffer it is given — a second extraction
  // over the same bytes would see "PDF file is empty". Hand it a copy so
  // callers can reuse their buffer across regions.
  const pdf = await getDocumentProxy(pdfBytes.slice());
  const page = await pdf.getPage(1);
  const { width: W, height: H } = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  return (content.items as RawTextItem[])
    .filter((i) => i.str.trim().length > 0)
    .map((i) => ({
      str: i.str,
      x0: i.transform[4]! / W,
      x1: (i.transform[4]! + i.width) / W,
      y0: 1 - (i.transform[5]! + i.height) / H,
      y1: 1 - i.transform[5]! / H,
    }));
}

export function itemsInBbox(items: PositionedItem[], bbox: Bbox): PositionedItem[] {
  return items.filter((i) => {
    const cx = (i.x0 + i.x1) / 2;
    const cy = (i.y0 + i.y1) / 2;
    return cx >= bbox.x0 && cx <= bbox.x1 && cy >= bbox.y0 && cy <= bbox.y1;
  });
}

export function joinReadingOrder(items: PositionedItem[]): string {
  const BAND = 0.008; // items within this vertical distance share a line
  const sorted = [...items].sort((a, b) => (Math.abs(a.y0 - b.y0) > BAND ? a.y0 - b.y0 : a.x0 - b.x0));
  return sorted
    .map((i) => i.str)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The whole primitive: pdf bytes + bbox → the text layer inside it. */
export async function extractTextLayer(pdfBytes: Uint8Array, bbox: Bbox): Promise<string> {
  return joinReadingOrder(itemsInBbox(await pageTextItems(pdfBytes), bbox));
}

export const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export const bytesToB64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
