/**
 * The instruction runtime: an eager, document-only JSX runtime where
 * `JSX.Element` IS `string`.
 *
 * This is a separate import source from the package's data runtime on
 * purpose. `jsx-data-runtime.ts` builds lazy `{ type, props }` DataElements
 * for the compiler/reconciler to walk; here there is no element tree at all —
 * `jsx()` invokes the component immediately, children evaluate before
 * parents, and a whole tree collapses bottom-up into a finished string the
 * moment it evaluates.
 *
 * The point is flue 2.0's return contract. A 2.0 agent keeps its capabilities
 * in hooks (`useModel`, `useTool`, …) and RETURNS its instruction document;
 * the runtime's only check is `typeof value === "string"`. Because every
 * component here returns a string, `return <System>…</System>` already is
 * that string by the time `return` executes — a compositional document layer
 * with zero flue changes. Opt in per file with the standard pragma comment:
 * `@jsxImportSource @agent-jsx/core/instruction`.
 */

/** Anything a component may receive as children. An object is a bug (an uncalled component). */
export type InstructionChild =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly InstructionChild[];

/** A component is a plain function from props to the rendered string. */
export type InstructionComponent<P = Record<string, unknown>> = (props: P) => string;

/**
 * Flatten children into one string, React-style: `null`/`undefined`/booleans
 * render as nothing (so `{cond && <X/>}` works), numbers stringify, arrays
 * flatten, and strings concatenate DIRECTLY — no separator is ever injected,
 * which is what keeps `Reply concisely {name}.` inline. Block separation is
 * the block components' job: each prefixes itself with a paragraph break.
 */
export function renderChildren(children: InstructionChild): string {
  if (children === null || children === undefined || typeof children === "boolean") return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(renderChildren).join("");
  throw new Error(
    `[agent-jsx/instruction] Unsupported child of type ${typeof children}. Children are ` +
      "strings, numbers, booleans/null (skipped), or arrays of those — an object usually " +
      "means a component was passed uncalled, or a data-runtime element leaked into the " +
      "instruction runtime.",
  );
}

/**
 * Finalize a document: collapse blank-line runs to one blank line and trim.
 * Runs only appear when raw text children carry their own trailing newlines
 * next to a self-prefixing block; the collapse makes that harmless.
 */
export function renderDocument(children: InstructionChild): string {
  return renderChildren(children)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function jsx(type: unknown, props: Record<string, unknown> | null, _key?: unknown): string {
  if (typeof type !== "function") {
    throw new Error(
      "[agent-jsx/instruction] Only function components exist in this runtime — a component " +
        "is a plain function returning a string; there are no intrinsic (lowercase) " +
        `elements. Received: ${String(type)}`,
    );
  }
  const rendered = (type as InstructionComponent)(props ?? {});
  if (typeof rendered !== "string") {
    throw new Error(
      `[agent-jsx/instruction] Component ${(type as { name?: string }).name || "<anonymous>"} ` +
        `returned ${typeof rendered}; every component must return a string (the runtime is ` +
        "eager — there is no element tree to resolve later).",
    );
  }
  return rendered;
}

// Multiple children vs single child differ only in how the compiler packs
// `props.children`; both lower to the same eager call.
export const jsxs = jsx;

/** `<>…</>` concatenates its children directly. */
export function Fragment(props: { children?: InstructionChild }): string {
  return renderChildren(props.children);
}

// The typing surface TypeScript reads under `jsx: react-jsx` with this module
// as the import source. `Element = string` is the point: a JSX expression
// typechecks against flue's `string | undefined` agent return type as-is.
export namespace JSX {
  export type Element = string;
  // Contravariant parameter: `never` here means "any single-props component
  // that returns a string" is a valid element type.
  export type ElementType = (props: never) => string;
  export interface IntrinsicElements {
    [name: string]: never;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
  export interface IntrinsicAttributes {}
}
