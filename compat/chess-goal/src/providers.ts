/**
 * Think-turn adapters for the GOAL worker.
 *
 * DELIBERATE DIFFERENCE from compat/chess/src/providers.ts: this parser never
 * throws on a bad or illegal move. In the goal design the DOMAIN reducer is
 * the authority on legality — an illegal decision reaches `reduceChessTurn`,
 * which refuses it, records `lastError`, dispatches NO outcome, and leaves the
 * same phase mounted; the seat's next turn context then carries `lastError`
 * as the re-prompt. Throwing here would turn that supervised refusal into a
 * transport error and hide the goal layer's behavior.
 */

export interface ChessTurnInput {
  ply: number;
  side: "white" | "black";
  fen: string;
  legalMoves: string[];
  history: unknown[];
  /** The domain's refusal of the seat's previous decision, if any. */
  lastError?: string | null;
}

export interface ThinkTurnTrace {
  requestId: string;
  text: string;
  reasoning: string;
}

export interface ChessDecision {
  move: string;
  note: string;
  thought: string;
}

const MAX_THOUGHT_CHARS = 480;

function cleanJson(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

function publicThought(reasoning: string, fallback: string): string {
  const normalized = (reasoning.trim() || fallback.trim()).replace(/\s+/g, " ");
  return normalized.length <= MAX_THOUGHT_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_THOUGHT_CHARS)}…`;
}

/**
 * Shape Think's public result into a decision for the domain reducer.
 * Unparseable output falls back to the raw text — board.tsx's parseDecision
 * regex-extracts a UCI move from prose or records "no parseable UCI move".
 * An illegal move is passed through untouched: refusing it is the domain's job.
 */
export function parseThinkDecision(
  trace: ThinkTurnTrace,
): ChessDecision | string {
  const clean = cleanJson(trace.text);
  let value: unknown;
  try {
    value = JSON.parse(clean);
  } catch {
    return trace.text;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { move?: unknown }).move !== "string"
  ) {
    return trace.text;
  }
  const move = (value as { move: string }).move.toLowerCase();
  const rawNote = (value as { note?: unknown }).note;
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  return { move, note, thought: publicThought(trace.reasoning, note) };
}

/** The board is bound as composition props on the generated Think class; the
 * user message only triggers the turn — and carries the domain's refusal of
 * the previous decision, when there was one, as the re-prompt. */
export function turnMessage(turn: ChessTurnInput): string {
  const parts = [
    `Play ${turn.side}'s move for ply ${turn.ply}.`,
    "Use the legalMoves from your current system prompt.",
    "Return only the JSON move object requested by that prompt.",
  ];
  if (turn.lastError) {
    parts.unshift(`Your previous decision was refused: ${turn.lastError}.`);
  }
  return parts.join(" ");
}
