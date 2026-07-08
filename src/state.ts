/**
 * Agent state — dev/React path.
 *
 * The store itself (`createStore`), the static-eval flag (`withStaticEval`),
 * and the `AgentStore` type are react-free and live in `store.ts` so they can
 * ship inside compiled artifacts. This module re-exports them and adds the one
 * react-coupled piece: a `useAgentState` bridged into React via
 * useSyncExternalStore, mirroring cloudflare/agents — the Agent DO owns state
 * and both the server-side tree (here) and browser clients (`useAgent`)
 * subscribe to the same source of truth.
 *
 * Compiled targets import `useAgentState` from `store.ts` instead (a plain
 * read): they evaluate components off the React stack, where a real hook would
 * throw. Under `withStaticEval` this version also degenerates to a read, so
 * the dev evaluator path stays consistent with the compiled one.
 */

import { useSyncExternalStore } from "react";
import { isStaticEval, type AgentStore } from "./store.ts";

export { createStore, withStaticEval, type AgentStore } from "./store.ts";

export function useAgentState<S extends Record<string, unknown>>(store: AgentStore<S>): S {
  if (isStaticEval()) return store.get();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
