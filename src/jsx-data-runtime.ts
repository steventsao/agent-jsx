/**
 * A react-free JSX runtime for COMPILED artifacts.
 *
 * JSX is compiler syntax; the runtime defines the semantics. In compiled
 * packages the component .tsx files are transformed with
 * `jsxImportSource: "#agentjsx"` (a package-imports alias to this file), so
 * `<task .../>` builds a plain `{ type, props }` object — exactly the shape
 * `compile/evaluate.ts` walks — and React never enters the worker bundle,
 * not even for syntax. Fragment shares React's registered symbol so the
 * evaluator (and any element authored under the dev/React transform) agrees.
 */

export const Fragment: unique symbol = Symbol.for("react.fragment") as never;

export interface DataElement {
  type: unknown;
  props: Record<string, unknown>;
  key?: unknown;
}

export function jsx(
  type: unknown,
  props: Record<string, unknown> | null,
  key?: unknown
): DataElement {
  const el: DataElement = { type, props: props ?? {} };
  if (key !== undefined) el.key = key;
  return el;
}

export const jsxs = jsx;

/** Dev transform entry (jsxDEV(type, props, key, isStatic, source, self)). */
export function jsxDEV(type: unknown, props: Record<string, unknown> | null, key?: unknown): DataElement {
  return jsx(type, props, key);
}

// Minimal JSX namespace so the package tsconfig can typecheck against this
// import source. Intrinsics are typed loosely here — authoring-time safety
// lives in the dev environment (real React types + intrinsics.d.ts).
export namespace JSX {
  export type Element = DataElement;
  export type ElementType = unknown;
  export interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
}
