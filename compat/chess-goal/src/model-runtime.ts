import { createOpenRouter } from "@openrouter/ai-sdk-provider";

interface OpenRouterEnv {
  OPENROUTER_API_KEY?: string;
}

/** Deployment-owned model resolution. Agent source owns the explicit id; this
 * module owns provider packages, credentials, and public-reasoning settings. */
export function resolveChessModel(env: unknown, model: string) {
  if (!model.startsWith("openrouter/")) return model;

  const apiKey = (env as OpenRouterEnv).OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");

  const modelId = model.slice("openrouter/".length);
  if (!modelId.includes("/")) {
    throw new Error(`invalid OpenRouter model id ${model}`);
  }

  return createOpenRouter({
    apiKey,
    compatibility: "strict",
    appName: "Agent JSX Chess",
    appUrl: "https://github.com/steventsao/agent-jsx",
  }).chat(modelId, {
    reasoning: { effort: "low", exclude: false },
  });
}
