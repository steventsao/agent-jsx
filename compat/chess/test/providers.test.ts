import { describe, expect, it } from "bun:test";
import { chooseMove, type ModelEnv } from "../src/providers.ts";
import { GeminiAgent, OpenAIAgent } from "../src/agents/players.tsx";

const turn = {
  ply: 0,
  side: "white" as const,
  fen: "start-fen",
  legalMoves: ["e2e4", "d2d4"],
  history: [],
};

const env: ModelEnv = {
  OPENROUTER_API_KEY: "server-openrouter-secret",
  GEMINI_API_KEY: "server-gemini-secret",
  OPENAI_MODEL: "openai/gpt-5-mini",
  GEMINI_MODEL: "gemini-2.5-flash",
};

describe("chess model providers", () => {
  it("calls OpenRouter with a strict legal-move schema and parses JSON", async () => {
    let request: Request | undefined;
    const decision = await chooseMove(OpenAIAgent, turn, env, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ choices: [{ message: { content: '{"move":"e2e4","note":"center"}' } }] });
    });

    expect(request?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer server-openrouter-secret");
    const body = await request?.json() as any;
    expect(body.model).toBe("openai/gpt-5-mini");
    expect(body.response_format.json_schema.schema.properties.move.enum).toEqual(turn.legalMoves);
    expect(decision).toEqual({ move: "e2e4", note: "center" });
  });

  it("calls Gemini server-side with the same legal-move schema", async () => {
    let request: Request | undefined;
    const decision = await chooseMove(GeminiAgent, turn, env, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"move":"d2d4","note":"space"}' }] } }] });
    });

    expect(request?.url).toContain("gemini-2.5-flash:generateContent");
    expect(request?.headers.get("x-goog-api-key")).toBe("server-gemini-secret");
    const body = await request?.json() as any;
    expect(body.generationConfig.responseSchema.properties.move.enum).toEqual(turn.legalMoves);
    expect(body.generationConfig.responseSchema.additionalProperties).toBeUndefined();
    expect(decision).toEqual({ move: "d2d4", note: "space" });
  });

  it("rejects syntactically valid output when the move is not legal", async () => {
    await expect(
      chooseMove(OpenAIAgent, turn, env, async () =>
        Response.json({ choices: [{ message: { content: '{"move":"e2e5","note":"oops"}' } }] }),
      ),
    ).rejects.toThrow("illegal move");
  });

  it("never accepts a browser-supplied provider key", async () => {
    const keys = Object.keys(env);
    expect(keys).toEqual(["OPENROUTER_API_KEY", "GEMINI_API_KEY", "OPENAI_MODEL", "GEMINI_MODEL"]);
  });
});
