/** Dev-mode automatic runtime: same eager semantics, source info discarded. */
import { jsx } from "./jsx-runtime.ts";

export * from "./jsx-runtime.ts";

export function jsxDEV(
  type: unknown,
  props: Record<string, unknown> | null,
  key?: unknown,
  _isStaticChildren?: boolean,
  _source?: unknown,
  _self?: unknown,
): string {
  return jsx(type, props, key);
}
