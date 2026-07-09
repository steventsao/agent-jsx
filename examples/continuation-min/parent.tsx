/**
 * Root of the minimal continuation pair, expressed with CONTINUATION NESTING —
 * the same shape as layout-review but pure-compute, so the whole round-trip is
 * deterministic on real workerd (compat/cloudflare/test/continuation.spec.ts):
 *
 *   parent spawns the emitter (static) → emitter's <task> emits items in ITS
 *   own DO → reserved `__emit` RPC lands the items in the parent's durable
 *   `__outputs` → parent re-renders → the continuation fans out one <ContFolder>
 *   per item → each folder runs in its own DO and folds its result back here.
 *
 * The folders are the PARENT's direct children (parent spawns them, parent env
 * binds them, `onFolded` folds into THIS state) — grandchildren by topology,
 * parent-owned by ownership. The continuation is pure: it re-renders from the
 * persisted `__outputs` slot, so no closure ever serializes.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";
import { ContEmitter } from "./emitter.tsx";
import { ContFolder } from "./folder.tsx";

export interface ContRootState extends Record<string, unknown> {
  /** The seed to fan out; null at rest. Pushed in via applyState. */
  seed: string | null;
  /** Upper-cased items, folded up from the folders as they complete. */
  folded: Record<string, string>;
}

export const initialContRootState: ContRootState = { seed: null, folded: {} };

export const ContRoot = agentComponent<Record<string, unknown>, ContRootState>({
  agentName: "cont-root",
  initialState: initialContRootState,
  impl: ({ store }) => {
    const { seed, folded } = useAgentState(store);

    const fold = (item: string, upper: string) =>
      store.set((s) => ({ ...s, folded: { ...s.folded, [item]: upper } }));

    return (
      <>
        {/* The emitter is the root's standing subagent (static). Its emitted
            items drive the continuation below — the folders it maps are the
            root's own children, so their results fold back into THIS state. */}
        <ContEmitter name="emit:main" seed={seed}>
          {(items) =>
            items.map((item) => (
              <ContFolder key={item} name={`fold:${item}`} item={item} onFolded={fold} />
            ))
          }
        </ContEmitter>

        <prompt>
          <sys p={10}>Fan out one folder per emitted item; collect the results.</sys>
          <msg p={6}>
            {seed
              ? `${Object.keys(folded).length} item(s) folded`
              : "waiting for a seed"}
          </msg>
        </prompt>
      </>
    );
  },
});
