/**
 * Deployment-owned provider resolution — the live half of the ModelProvider
 * seam. The agent composition never sees this module directly: the PM's ports
 * carry whichever provider the worker resolves, and the classify grant meters
 * whatever `usage` the provider reports.
 *
 * Credentials by NAME only: `env.OPENROUTER_API_KEY` is a secret binding
 * (`wrangler secret put OPENROUTER_API_KEY`). Tests never take this path —
 * wrangler.jsonc sets PARSE_PM_FAKE_PROVIDER=1 and the worker resolves the
 * scripted fake instead.
 */

import type { ModelProvider, RegionClassification } from "./agents/ports.ts";

interface ProviderEnv {
  OPENROUTER_API_KEY?: string;
  PARSE_PM_MODEL?: string;
}

/** Cheap + proven live in this repo (compat/chess-goal deploy). */
const DEFAULT_MODEL = "openai/gpt-5-mini";

/** The flat per-call ceiling the PM debits BEFORE calling. Also the
 *  conservative fallback if a response ever omits `usage.cost`. */
export const LIVE_MAX_CALL_COST_USD = 0.01;

const LABELS = ["heading", "byline", "abstract", "body-text", "table", "figure", "caption", "other"];

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export function resolveParseProvider(env: unknown): ModelProvider {
  const apiKey = (env as ProviderEnv).OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const model = (env as ProviderEnv).PARSE_PM_MODEL || DEFAULT_MODEL;

  return {
    maxCallCostUsd: LIVE_MAX_CALL_COST_USD,
    async classifyRegion({ regionId, text }): Promise<RegionClassification> {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-title": "Agent JSX Parse PM",
        },
        body: JSON.stringify({
          model,
          max_tokens: 12,
          // Ask OpenRouter to include real accounting in the response — the
          // PM meters spend from THESE fields, never from its own guesses.
          usage: { include: true },
          messages: [
            {
              role: "system",
              content: `You label one region of a parsed document page. Reply with exactly ONE of: ${LABELS.join(", ")}.`,
            },
            { role: "user", content: `Region "${regionId}":\n${text.slice(0, 1200)}` },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`openrouter ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const json = (await response.json()) as OpenRouterResponse;
      const raw = (json.choices?.[0]?.message?.content ?? "").trim().toLowerCase();
      const label = LABELS.find((candidate) => raw.includes(candidate)) ?? "other";
      const usage = json.usage ?? {};
      return {
        label,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          costUsd: typeof usage.cost === "number" ? usage.cost : LIVE_MAX_CALL_COST_USD,
        },
      };
    },
  };
}
