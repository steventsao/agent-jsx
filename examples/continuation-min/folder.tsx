/**
 * The grandchild LEAF of the minimal continuation pair. One <ContFolder> is
 * mapped per emitted item by the parent's continuation, so these are the
 * PARENT's direct children — parent spawns them, parent env binds them, their
 * results fold back into PARENT state.
 *
 * Each folder runs one pure <task> that upper-cases its item, records the
 * result in its OWN durable state (`folded`, so a grandchild's state is visible
 * in its own DO), and folds it back to the parent via the `onFolded` callback.
 */

import { agentComponent } from "../../src/agent-component.tsx";
import { useAgentState } from "../../src/state.ts";

export interface ContFolderProps extends Record<string, unknown> {
  item: string;
  /** Fold the result back to the parent (callback prop → generated RPC). */
  onFolded: (item: string, upper: string) => void;
}

export interface ContFolderState extends Record<string, unknown> {
  /** The upper-cased item once the fold task has run; null at rest. */
  folded: string | null;
}

export const ContFolder = agentComponent<ContFolderProps, ContFolderState>({
  agentName: "cont-folder",
  initialState: { folded: null },
  sampleProps: { item: "sample", onFolded: () => {} },
  impl: ({ item, onFolded, store }) => {
    const { folded } = useAgentState(store);
    return (
      <>
        {!folded && (
          <task
            name={`work:${item}`}
            run={async () => item.toUpperCase()}
            onDone={async (upper) => {
              store.set({ folded: String(upper) });
              // AWAIT the fold-back: on Cloudflare it is a cross-DO callback RPC;
              // an un-awaited one is left pending when this reconcile resolves
              // (COMPAT-REPORT #37). The parent's gate is open at its await points,
              // so awaiting is deadlock-safe (COMPAT-REPORT #34).
              await onFolded(item, String(upper));
            }}
          />
        )}
        <prompt>
          <sys p={10}>Fold one item ({item}) and report it back.</sys>
          <msg p={7}>{folded ? `folded ${item} → ${folded}` : "fold pending."}</msg>
        </prompt>
      </>
    );
  },
});
