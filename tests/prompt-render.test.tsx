/**
 * Priompt-lite unit tests.
 *
 * renderPrompt (src/prompt.ts): find the highest priority cutoff whose blocks
 * fit the token budget (chars/4, ceil), emit survivors in TREE order, system
 * blocks prefixed `[system] `.
 *
 * collectPrompt (src/tree.ts:79-109): flatten <prompt> subtrees into blocks —
 * absolute `p`, relative `prel` (accumulating through nested scopes), base
 * priority 5, role from the leaf tag, whitespace-only blocks pruned, every
 * <prompt> root collected.
 */

import { describe, expect, it } from "bun:test";
import { renderPrompt } from "../src/prompt.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { collectPrompt } from "../src/tree.ts";
import type { PromptBlock } from "../src/types.ts";

const block = (
  priority: number,
  text: string,
  role: "system" | "user" = "user"
): PromptBlock => ({ priority, role, text });

/** n chars → ceil(n / 4) tokens. */
const chars = (n: number, c = "x") => c.repeat(n);

describe("renderPrompt — budget cutoffs", () => {
  it("a tight budget keeps only the highest-priority block", () => {
    const blocks = [block(10, chars(40, "a")), block(8, chars(40, "b")), block(5, chars(40, "c"))];
    const rendered = renderPrompt(blocks, 15);

    expect(rendered.included).toEqual([blocks[0]]);
    expect(rendered.excluded).toEqual([blocks[1], blocks[2]]);
    expect(rendered.usedTokens).toBe(10);
    expect(rendered.budget).toBe(15);
    expect(rendered.text).toBe(chars(40, "a"));
  });

  it("widens the survivor set while the lower cutoff still fits", () => {
    const blocks = [block(10, chars(40, "a")), block(8, chars(40, "b")), block(5, chars(40, "c"))];
    const rendered = renderPrompt(blocks, 20);

    expect(rendered.included).toEqual([blocks[0], blocks[1]]);
    expect(rendered.excluded).toEqual([blocks[2]]);
    expect(rendered.usedTokens).toBe(20);
    expect(rendered.text).toBe(`${chars(40, "a")}\n${chars(40, "b")}`);
  });

  it("emits survivors in tree order, not priority order", () => {
    const blocks = [block(5, "low"), block(10, "high")];
    const rendered = renderPrompt(blocks, 100);

    expect(rendered.included).toEqual([blocks[0], blocks[1]]);
    expect(rendered.text).toBe("low\nhigh");
  });

  it("prefixes system blocks with `[system] ` and joins blocks with newlines", () => {
    const rendered = renderPrompt(
      [block(10, "rules", "system"), block(9, "question")],
      100
    );
    expect(rendered.text).toBe("[system] rules\nquestion");
  });

  it("a budget below the smallest block excludes everything", () => {
    const blocks = [block(10, chars(40, "a")), block(9, chars(40, "b"))];
    const rendered = renderPrompt(blocks, 5);

    expect(rendered.included).toEqual([]);
    expect(rendered.excluded).toEqual(blocks);
    expect(rendered.text).toBe("");
    expect(rendered.usedTokens).toBe(0);
  });

  it("counts tokens as ceil(chars / 4)", () => {
    const fits = renderPrompt([block(10, chars(41))], 11);
    expect(fits.usedTokens).toBe(11);
    expect(fits.included).toHaveLength(1);

    const pruned = renderPrompt([block(10, chars(41))], 10);
    expect(pruned.included).toEqual([]);
  });
});

describe("collectPrompt — priorities and roles", () => {
  it("resolves `prel` against the enclosing scope, accumulating through nesting", () => {
    const roots = evaluateTree(
      <prompt>
        <scope p={7}>
          <msg prel={2}>boosted</msg>
          <msg>plain</msg>
          <scope prel={-4}>
            <msg prel={1}>nested</msg>
          </scope>
        </scope>
      </prompt>
    );

    expect(collectPrompt(roots)).toEqual([
      { priority: 9, role: "user", text: "boosted" },
      { priority: 7, role: "user", text: "plain" },
      { priority: 4, role: "user", text: "nested" },
    ]);
  });

  it("an absolute `p` overrides the inherited scope priority", () => {
    const roots = evaluateTree(
      <prompt>
        <scope p={3}>
          <msg p={9}>absolute wins</msg>
        </scope>
      </prompt>
    );

    expect(collectPrompt(roots)).toEqual([
      { priority: 9, role: "user", text: "absolute wins" },
    ]);
  });

  it("untagged blocks land at the base priority 5", () => {
    const roots = evaluateTree(
      <prompt>
        <sys>no priority</sys>
      </prompt>
    );

    expect(collectPrompt(roots)).toEqual([
      { priority: 5, role: "system", text: "no priority" },
    ]);
  });

  it("keeps the leaf tag's role through intermediate scopes", () => {
    const roots = evaluateTree(
      <prompt>
        <scope p={10}>
          <sys>system inside scope</sys>
          <msg>user inside scope</msg>
        </scope>
      </prompt>
    );

    expect(collectPrompt(roots)).toEqual([
      { priority: 10, role: "system", text: "system inside scope" },
      { priority: 10, role: "user", text: "user inside scope" },
    ]);
  });

  it("prunes whitespace-only blocks and trims survivors", () => {
    const roots = evaluateTree(
      <prompt>
        <sys p={10}>{"   "}</sys>
        <msg p={9}>real</msg>
        <sys p={8}>{""}</sys>
        <msg p={7}>{"  padded  "}</msg>
      </prompt>
    );

    expect(collectPrompt(roots)).toEqual([
      { priority: 9, role: "user", text: "real" },
      { priority: 7, role: "user", text: "padded" },
    ]);
  });

  it("collects every <prompt> root, in order", () => {
    const roots = evaluateTree(
      <>
        <prompt>
          <sys p={10}>first</sys>
        </prompt>
        <prompt>
          <msg p={9}>second</msg>
        </prompt>
      </>
    );

    expect(collectPrompt(roots)).toEqual([
      { priority: 10, role: "system", text: "first" },
      { priority: 9, role: "user", text: "second" },
    ]);
  });
});
