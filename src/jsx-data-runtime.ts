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

import type {
  PhaseProps,
  ScheduleProps,
  SensorProps,
  SubagentProps,
  TaskProps,
  ToolProps,
} from "./types.ts";

export const Fragment: unique symbol = Symbol.for("react.fragment") as never;
// Stable cross-package protocol key retained across the npm namespace rename.
export const dataElementBrand: unique symbol = Symbol.for(
  "@steventsao/agent-jsx/data-element",
) as never;

export interface DataElement {
  type: unknown;
  props: Record<string, unknown>;
  key?: unknown;
  readonly [dataElementBrand]: true;
}

export function jsx(
  type: unknown,
  props: Record<string, unknown> | null,
  key?: unknown
): DataElement {
  const el: DataElement = {
    type,
    props: props ?? {},
    [dataElementBrand]: true,
  };
  if (key !== undefined) el.key = key;
  return el;
}

export const jsxs = jsx;

/** Dev transform entry (jsxDEV(type, props, key, isStatic, source, self)). */
export function jsxDEV(type: unknown, props: Record<string, unknown> | null, key?: unknown): DataElement {
  return jsx(type, props, key);
}

// JSX namespace for generated packages. It preserves the authored intrinsic
// contracts and `key` checking while returning plain DataElements.
export namespace JSX {
  export type Element = DataElement;
  export type ElementType = unknown;
  export interface IntrinsicAttributes {
    key?: unknown;
  }
  export interface IntrinsicElements {
    sensor: SensorProps & IntrinsicAttributes;
    schedule: ScheduleProps & IntrinsicAttributes;
    subagent: SubagentProps & IntrinsicAttributes;
    tool: ToolProps & IntrinsicAttributes;
    task: TaskProps & IntrinsicAttributes;
    // Goal declaration: reconciles to no record (see src/tree.ts collectPhases).
    // `children` is re-widened to unknown — this runtime builds DataElements,
    // not react nodes, exactly like prompt/sys/msg below.
    phase: Omit<PhaseProps, "children"> & { children?: unknown } & IntrinsicAttributes;
    prompt: { children?: unknown } & IntrinsicAttributes;
    sys: { p?: number; prel?: number; children?: unknown } & IntrinsicAttributes;
    msg: { p?: number; prel?: number; children?: unknown } & IntrinsicAttributes;
    scope: { p?: number; prel?: number; children?: unknown } & IntrinsicAttributes;
  }
  export interface ElementChildrenAttribute {
    children: {};
  }
}
