import { describe, expect, it } from "bun:test";
import { parseThinkDecision, turnMessage, type ThinkTurnTrace } from "../src/providers.ts";

const turn = {
  ply: 0,
  side: "white" as const,
  fen: "start-fen",
  legalMoves: ["e2e4", "d2d4"],
  history: [],
};

const trace = (overrides: Partial<ThinkTurnTrace> = {}): ThinkTurnTrace => ({
  requestId: "turn-1",
  text: '{"move":"e2e4","note":"claim central space"}',
  reasoning: "Develop while opening lines for both bishops.",
  ...overrides,
});

describe("Think chess turns", () => {
  it("keeps the structured move and public reasoning as a thought bubble", () => {
    expect(parseThinkDecision(trace(), turn)).toEqual({
      move: "e2e4",
      note: "claim central space",
      thought: "Develop while opening lines for both bishops.",
    });
  });

  it("falls back to the concise move note when a provider emits no reasoning part", () => {
    expect(parseThinkDecision(trace({ reasoning: "" }), turn).thought).toBe("claim central space");
  });

  it("rejects syntactically valid output when the move is not legal", () => {
    expect(() =>
      parseThinkDecision(trace({ text: '{"move":"e2e5","note":"oops"}' }), turn),
    ).toThrow("illegal move");
  });

  it("caps and normalizes model reasoning before it enters durable state", () => {
    const thought = parseThinkDecision(trace({ reasoning: `  ${"plan ".repeat(200)}  ` }), turn).thought;
    expect(thought.length).toBeLessThanOrEqual(481);
    expect(thought.endsWith("…")).toBe(true);
    expect(thought).not.toContain("  ");
  });

  it("sends only turn intent because current board props become the generated Think system prompt", () => {
    expect(turnMessage(turn)).toContain("Return only the JSON move object");
    expect(turnMessage(turn)).not.toContain("OPENROUTER_API_KEY");
  });
});
