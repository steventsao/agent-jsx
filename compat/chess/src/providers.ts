export interface ChessTurnInput {
  ply: number;
  side: "white" | "black";
  fen: string;
  legalMoves: string[];
  history: unknown[];
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

/** Validate Think's public assistant result before it can reach chess.js. */
export function parseThinkDecision(
  trace: ThinkTurnTrace,
  turn: ChessTurnInput,
): ChessDecision {
  const clean = cleanJson(trace.text);
  let value: unknown;
  try {
    value = JSON.parse(clean);
  } catch {
    throw new Error(`model returned invalid JSON: ${clean.slice(0, 160)}`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { move?: unknown }).move !== "string"
  ) {
    throw new Error("model response is missing a move string");
  }
  const move = (value as { move: string }).move.toLowerCase();
  if (!turn.legalMoves.includes(move)) throw new Error(`model returned illegal move ${move}`);
  const rawNote = (value as { note?: unknown }).note;
  const note = typeof rawNote === "string" ? rawNote.trim() : "";
  return { move, note, thought: publicThought(trace.reasoning, note) };
}

/** The actual board is supplied as transient composition props to the generated
 * Think class, so the user message only triggers the already-contextual turn. */
export function turnMessage(turn: ChessTurnInput): string {
  return [
    `Play ${turn.side}'s move for ply ${turn.ply}.`,
    "Use the legalMoves from your current system prompt.",
    "Return only the JSON move object requested by that prompt.",
  ].join(" ");
}
