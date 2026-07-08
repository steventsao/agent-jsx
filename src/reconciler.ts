/**
 * A custom react-reconciler host whose "DOM" is agent infrastructure.
 *
 * Two-level reconciliation:
 *   1. React diffs the element tree (keys give child identity, StrictMode
 *      double-renders safely because render is pure).
 *   2. After every commit (resetAfterCommit) we sweep the committed tree into
 *      a flat desired-state list and hand it to the AgentHost, which diffs by
 *      (kind, name) and applies idempotent upserts/removals.
 *
 * Level 2 is what a UI renderer doesn't need and an agent runtime does: the
 * in-memory fiber tree dies on hibernation, but the host's records persist,
 * so a fresh mount converges (rebind) instead of duplicating schedules — the
 * problem cloudflare/agents currently patches with `{ idempotent: true }`
 * options and onStart() warnings.
 *
 * Host config shape follows react-nil (react-reconciler 0.31 / React 19).
 */

import * as React from "react";
import Reconciler from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority } from "react-reconciler/constants.js";
import type { AgentHost, HostOp, InfraRecord } from "./types.ts";
import { collectInfra, type HostNode } from "./tree.ts";

// Re-export the react-free sweeps + HostNode for back-compat. The collectors
// live in `tree.ts` (no react-reconciler import) so compiled artifacts can
// use them without pulling the reconciler; this module keeps the dev/React
// mount path.
export { collectInfra, collectPrompt, type HostNode } from "./tree.ts";

export interface Container {
  /** Top-level host children — a fragment root appends several. */
  children: HostNode[];
  host: AgentHost;
  onOps: (ops: HostOp[]) => void;
}

const REACT_INTERNAL_PROPS = ["ref", "key", "children"];

function instanceProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key in props) {
    if (!REACT_INTERNAL_PROPS.includes(key)) out[key] = props[key];
  }
  return out;
}

let currentUpdatePriority = 0;

const reconciler = Reconciler({
  isPrimaryRenderer: false,
  warnsIfNotActing: false,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,

  createInstance: (type: string, props: Record<string, unknown>): HostNode => ({
    type,
    props: instanceProps(props),
    children: [],
  }),
  createTextInstance: (value: string): HostNode => ({ type: "text", props: { value }, children: [] }),

  appendInitialChild: (parent: HostNode, child: HostNode) => parent.children.push(child),
  appendChild: (parent: HostNode, child: HostNode) => parent.children.push(child),
  appendChildToContainer: (container: Container, child: HostNode) => container.children.push(child),
  insertBefore: (parent: HostNode, child: HostNode, before: HostNode) =>
    parent.children.splice(parent.children.indexOf(before), 0, child),
  insertInContainerBefore: (container: Container, child: HostNode, before: HostNode) =>
    container.children.splice(container.children.indexOf(before), 0, child),
  removeChild: (parent: HostNode, child: HostNode) =>
    parent.children.splice(parent.children.indexOf(child), 1),
  removeChildFromContainer: (container: Container, child: HostNode) =>
    container.children.splice(container.children.indexOf(child), 1),
  clearContainer: (container: Container) => (container.children.length = 0),

  commitUpdate: (
    instance: HostNode,
    _type: string,
    _prev: Record<string, unknown>,
    next: Record<string, unknown>
  ) => {
    instance.props = instanceProps(next);
  },
  commitTextUpdate: (instance: HostNode, _old: string, value: string) => {
    instance.props.value = value;
  },

  // The interesting part: one sweep per commit.
  prepareForCommit: () => null,
  resetAfterCommit: (container: Container) => {
    const desired: InfraRecord[] = [];
    for (const child of container.children) collectInfra(child, desired);
    const ops = container.host.reconcile(desired);
    if (ops.length) container.onOps(ops);
  },

  hideInstance() {},
  unhideInstance() {},
  hideTextInstance() {},
  unhideTextInstance() {},
  getPublicInstance: (instance: HostNode) => instance,
  getRootHostContext: () => ({}),
  getChildHostContext: (parent: unknown) => parent,
  shouldSetTextContent: () => false,
  finalizeInitialChildren: () => false,
  preparePortalMount() {},
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  detachDeletedInstance() {},
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  requestPostPaintCallback() {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: React.createContext(null),
  setCurrentUpdatePriority(p: number) {
    currentUpdatePriority = p;
  },
  getCurrentUpdatePriority: () => currentUpdatePriority,
  resolveUpdatePriority: () =>
    currentUpdatePriority !== 0 ? currentUpdatePriority : DefaultEventPriority,
  resetFormInstance() {},
} as any);

// ---------------------------------------------------------------------------
// Per-agent mount API

export interface Fiber {
  container: Container;
  update(element: React.ReactNode): void;
  flush<R>(fn: () => R): R;
  unmount(): void;
}

export function createFiber(host: AgentHost, onOps: (ops: HostOp[]) => void): Fiber {
  const container: Container = { children: [], host, onOps };
  const logError = (err: unknown) => console.error("[agent-jsx]", err);
  const root = (reconciler as any).createContainer(
    container,
    ConcurrentRoot,
    null, // hydrationCallbacks
    false, // isStrictMode (opt in by wrapping the element instead)
    null, // concurrentUpdatesByDefaultOverride
    "", // identifierPrefix
    logError, // onUncaughtError
    logError, // onCaughtError
    logError, // onRecoverableError
    null // transitionCallbacks
  );

  // react-reconciler 0.31: sync container updates + explicit sync flush.
  const r = reconciler as unknown as {
    updateContainerSync(el: React.ReactNode, root: unknown, ctx: null, cb?: () => void): void;
    flushSyncWork(): void;
    flushSyncFromReconciler<R>(fn: () => R): R;
  };

  return {
    container,
    update: (element) => {
      r.updateContainerSync(element, root, null, undefined);
      r.flushSyncWork();
    },
    flush: (fn) => {
      const result = r.flushSyncFromReconciler(fn);
      r.flushSyncWork();
      return result;
    },
    unmount: () => {
      r.updateContainerSync(null, root, null, undefined);
      r.flushSyncWork();
    },
  };
}
