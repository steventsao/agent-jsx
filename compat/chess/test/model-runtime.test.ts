import { describe, expect, test } from "bun:test";
import { resolveChessModel } from "../src/model-runtime.ts";

describe("chess deployment model adapter", () => {
  test("maps an explicit openrouter model id to an authenticated AI SDK model", () => {
    const model = resolveChessModel(
      { OPENROUTER_API_KEY: "test-key" },
      "openrouter/openai/gpt-5-mini",
    );

    expect(typeof model).toBe("object");
    expect((model as { modelId: string }).modelId).toBe("openai/gpt-5-mini");
    expect((model as { provider: string }).provider).toContain("openrouter");
  });

  test("keeps other explicit provider ids available to Think's built-in resolver", () => {
    expect(resolveChessModel({}, "@cf/openai/gpt-oss-20b")).toBe(
      "@cf/openai/gpt-oss-20b",
    );
  });

  test("fails before inference when the deployment credential is absent", () => {
    expect(() => resolveChessModel({}, "openrouter/openai/gpt-5-mini")).toThrow(
      "OPENROUTER_API_KEY is not configured",
    );
  });
});
