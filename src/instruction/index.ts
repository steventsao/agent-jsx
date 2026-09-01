/**
 * Instruction-document components for flue 2.0 agents.
 *
 * Design rule: blocks SELF-PREFIX a paragraph break (`\n\n`) and never end
 * with one. Plain text and `{expressions}` concatenate inline with no
 * separator, so prose interpolation stays prose; adjacent blocks separate
 * themselves; `<System>` (or `renderDocument`) trims the leading break off
 * the first block. Everything else is a user-defined function component
 * returning a string — these five are just the floor.
 *
 * Relationship to the rest of the package: the `<prompt>`/`<sys>`/`<msg>`
 * intrinsics are the COMPILED, budget-aware context layer (priompt-style
 * priorities rendered by `src/prompt.ts` at runtime); this module is the
 * AUTHORING layer for handwritten flue 2.0 hook agents, where the document
 * must leave the agent function as a plain string.
 */
import { renderChildren, renderDocument, type InstructionChild } from "./jsx-runtime.ts";

export {
  Fragment,
  jsx,
  jsxs,
  renderChildren,
  renderDocument,
  type InstructionChild,
  type InstructionComponent,
} from "./jsx-runtime.ts";

/**
 * The document root. Sugar over `renderDocument`: concatenates children,
 * collapses blank-line runs, trims. Returns the plain string an agent
 * function can hand straight to flue's `return`.
 */
export function System(props: { children?: InstructionChild }): string {
  return renderDocument(props.children);
}

/** A titled markdown section: `## Title` (level = heading depth) plus its content. */
export function Section(props: {
  title: string;
  level?: number;
  children?: InstructionChild;
}): string {
  const heading = `${"#".repeat(props.level ?? 2)} ${props.title}`;
  const content = renderChildren(props.children).trim();
  return content.length > 0 ? `\n\n${heading}\n\n${content}` : `\n\n${heading}`;
}

/** An explicit paragraph — text that must not attach to the preceding block. */
export function P(props: { children?: InstructionChild }): string {
  const content = renderChildren(props.children).trim();
  return content.length > 0 ? `\n\n${content}` : "";
}

/**
 * A markdown list. `items` is the dynamic form (`items={rules.map(…)}`);
 * multiple JSX children are the static form, one child per item. Empty and
 * falsy items are dropped; an empty list renders nothing.
 */
export function List(props: {
  items?: readonly InstructionChild[];
  ordered?: boolean;
  children?: InstructionChild;
}): string {
  const source =
    props.items ??
    (Array.isArray(props.children)
      ? props.children
      : props.children !== undefined
        ? [props.children]
        : []);
  const lines = source
    .map((item) => renderChildren(item).trim())
    .filter((line) => line.length > 0)
    .map((line, index) => `${props.ordered ? `${index + 1}.` : "-"} ${line}`);
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

/**
 * A fenced code block. Content is verbatim except for edge trimming — pass a
 * template literal to keep internal line breaks (JSX text collapses them).
 */
export function Code(props: { lang?: string; children?: InstructionChild }): string {
  const content = renderChildren(props.children)
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  return `\n\n\`\`\`${props.lang ?? ""}\n${content}\n\`\`\``;
}
