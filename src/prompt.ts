/**
 * Priompt-lite: assemble the committed <prompt> subtree into a context window
 * under a token budget.
 *
 * Semantics follow anysphere/priompt: every block has an absolute priority
 * (`p`) or one relative to its enclosing scope (`prel`); rendering finds the
 * highest cutoff C such that all blocks with priority >= C fit the budget,
 * then emits survivors in tree order. The context window is a viewport;
 * the prompt is responsive layout.
 *
 * Token counting is chars/4 — swap in a real tokenizer (or the real priompt
 * package, npm `priompt`) for production.
 */

import type { PromptBlock } from "./types.ts";

const tokens = (s: string) => Math.ceil(s.length / 4);

export interface RenderedPrompt {
  text: string;
  included: PromptBlock[];
  excluded: PromptBlock[];
  budget: number;
  usedTokens: number;
}

export function renderPrompt(blocks: PromptBlock[], budget: number): RenderedPrompt {
  // Candidate cutoffs are the distinct priorities, highest first.
  const cutoffs = [...new Set(blocks.map((b) => b.priority))].sort((a, b) => b - a);

  let included: PromptBlock[] = [];
  for (const cutoff of cutoffs) {
    const candidate = blocks.filter((b) => b.priority >= cutoff);
    const cost = candidate.reduce((n, b) => n + tokens(b.text), 0);
    if (cost <= budget) included = candidate;
    else break; // priorities below this cutoff only add more weight
  }

  const includedSet = new Set(included);
  const text = included
    .map((b) => (b.role === "system" ? `[system] ${b.text}` : b.text))
    .join("\n");

  return {
    text,
    included,
    excluded: blocks.filter((b) => !includedSet.has(b)),
    budget,
    usedTokens: included.reduce((n, b) => n + tokens(b.text), 0),
  };
}

/**
 * The context-window layer is OPTIONAL and has two sources. When the rendered
 * tree yields <prompt> blocks, the DECLARATIVE tag wins (priompt priorities +
 * token budget) — this is `renderPrompt`. When it yields none, fall back to the
 * IMPERATIVE `getPrompt` seam. When neither is present, the layer is empty.
 *
 * Presence is measured on `blocks.length`, not on rendered text: a budget that
 * excludes every declarative block still counts as "declarative present" and
 * does NOT fall through to getPrompt — the author asked for a budgeted prompt.
 */
export function renderPromptOrFallback(
  blocks: PromptBlock[],
  budget: number,
  fallback: () => string
): string {
  if (blocks.length > 0) return renderPrompt(blocks, budget).text;
  return fallback();
}
