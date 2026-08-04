import { describe, expect, it } from "bun:test";
import { parseThinkDecision, turnMessage, type ThinkTurnTrace } from "../src/providers.ts";

const turn = {
  ply: 0,
  side: "white" as const,
  fen: "start-fen",
  legalMoves: ["e2e4", "d2d4"],
  history: [],
  lastError: null,
};

const trace = (overrides: Partial<ThinkTurnTrace> = {}): ThinkTurnTrace => ({
  requestId: "turn-1",
  text: '{"move":"e2e4","note":"claim central space"}',
  reasoning: "Develop while opening lines for both bishops.",
  ...overrides,
});

describe("Think chess-goal turns", () => {
  it("keeps the structured move and public reasoning as a thought bubble", () => {
    expect(parseThinkDecision(trace())).toEqual({
      move: "e2e4",
      note: "claim central space",
      thought: "Develop while opening lines for both bishops.",
    });
  });

  it("falls back to the concise move note when a provider emits no reasoning part", () => {
    const decision = parseThinkDecision(trace({ reasoning: "" }));
    expect((decision as { thought: string }).thought).toBe("claim central space");
  });

  it("passes an ILLEGAL move through — refusing it is the domain reducer's job", () => {
    // Unlike compat/chess, this does NOT throw: the goal worker routes the
    // decision to reduceChessTurn, which records lastError and keeps the
    // phase mounted so the seat re-prompts with the refusal.
    expect(parseThinkDecision(trace({ text: '{"move":"e2e5","note":"oops"}' }))).toMatchObject({
      move: "e2e5",
    });
  });

  it("passes unparseable output through as raw text for the domain's UCI fallback", () => {
    expect(parseThinkDecision(trace({ text: "I will play e2e4!" }))).toBe("I will play e2e4!");
  });

  it("caps and normalizes model reasoning before it enters durable state", () => {
    const decision = parseThinkDecision(trace({ reasoning: `  ${"plan ".repeat(200)}  ` }));
    const thought = (decision as { thought: string }).thought;
    expect(thought.length).toBeLessThanOrEqual(481);
    expect(thought.endsWith("…")).toBe(true);
    expect(thought).not.toContain("  ");
  });

  it("sends only turn intent because current board props become the generated Think system prompt", () => {
    expect(turnMessage(turn)).toContain("Return only the JSON move object");
    expect(turnMessage(turn)).not.toContain("OPENROUTER_API_KEY");
    expect(turnMessage(turn)).not.toContain("refused");
  });

  it("carries the domain's refusal as the re-prompt after an illegal move", () => {
    const message = turnMessage({ ...turn, lastError: "illegal move e2e5; legal moves: e2e4" });
    expect(message).toContain("Your previous decision was refused: illegal move e2e5");
  });
});
