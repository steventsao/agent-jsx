/**
 * Core vocabulary. Two kinds of nodes come out of a render:
 *
 *  - INFRA nodes (<sensor> <schedule> <subagent> <tool>): declarations of
 *    durable capabilities. The host reconciles them like Terraform reconciles
 *    cloud resources — by (kind, name) identity, as idempotent upserts.
 *  - PROMPT nodes (<prompt> <sys> <msg> <scope>): the agent's context window
 *    as a tree, re-rendered from state, assembled under a token budget with
 *    priompt semantics (absolute `p`, relative `prel`).
 *
 * Function props (onEvent, onFire, onResult, run) are NEVER persisted. They
 * rebind on every commit — exactly like onClick in react-dom. Durability of
 * behavior comes from re-rendering the same code over persisted state, not
 * from serializing closures.
 */

export type InfraKind = "sensor" | "schedule" | "subagent" | "tool" | "task";

export type InfraCapabilityKind = "callback" | "method" | "result" | "continuation";

export interface InfraCapabilityBinding {
  kind: InfraCapabilityKind;
}

export interface InfraRecord {
  kind: InfraKind;
  /** Stable identity across renders and process restarts. Required. */
  name: string;
  /** JSON-serializable configuration (everything except function props). */
  config: Record<string, unknown>;
  /** Live callbacks, rebound every commit. Never serialized. */
  handlers: Record<string, (...args: any[]) => unknown>;
  /** Explicit cross-agent grants, keyed by the exact function prop name. This
   *  metadata is neither child input nor durable config. */
  bindings?: Record<string, InfraCapabilityBinding>;
  /** Live agent-class identity for local adapters that bind implementations by
   *  typed class rather than by the serialized `kind` string. Compiler-owned,
   *  never persisted or sent across a runtime boundary. */
  target?: object;
}

export type HostOp =
  | { op: "create"; kind: InfraKind; name: string }
  | { op: "update"; kind: InfraKind; name: string; changed: string[] }
  | { op: "rebind"; kind: InfraKind; name: string } // existed durably; handlers re-attached
  | { op: "remove"; kind: InfraKind; name: string };

/**
 * The boundary a real runtime implements (see docs/cloudflare-adapter.md for
 * the cloudflare/agents mapping). The renderer calls reconcile() once per
 * React commit with the full desired state.
 */
export interface AgentHost {
  reconcile(desired: InfraRecord[]): HostOp[];
}

// ---------------------------------------------------------------------------
// Prompt tree

export interface PromptBlock {
  /** Effective absolute priority (higher survives longer). */
  priority: number;
  role: "system" | "user";
  text: string;
}

// ---------------------------------------------------------------------------
// Intrinsic element props (JSX augmentation lives in intrinsics.d.ts)

export interface SensorProps {
  name: string;
  /** Poll cadence in world ticks (loopy: `@sensor(poll="5m")`). */
  interval: number;
  url: string;
  /** Receives the observed status each poll. Policy lives in the component. */
  onStatus: (status: number, t: number) => void;
}

export interface ScheduleProps {
  name: string;
  /** Fire every N world ticks (stand-in for cron). */
  every: number;
  onFire: (t: number) => void;
}

export interface SubagentProps {
  name: string;
  kind: string;
  /** Compiler-owned capability ACL. Raw intrinsic users may set this directly;
   *  agentComponent boundaries derive it exhaustively from their typed spec. */
  __agentBindings?: Record<string, InfraCapabilityBinding>;
  /** Compiler-owned live class identity. It is collected outside `config`, so
   *  provider credentials/adapters can key a typed registry without exposing
   *  or serializing implementation details. */
  __agentTarget?: object;
  /** Everything else is the child's contract: serializable values become the
   *  child's props (pushed on change); functions become callbacks the child
   *  invokes (compiled to RPC back to the parent). Prefer composing via
   *  agentComponent() over using this intrinsic directly. */
  [prop: string]: unknown;
}

export interface TaskProps {
  name: string;
  /** One-shot work, executed by the host exactly once per name (mount).
   *  Unmount before completion cancels. Result flows to onDone. */
  run: () => unknown | Promise<unknown>;
  onDone?: (result: unknown) => void;
}

export interface ToolProps {
  name: string;
  description: string;
  run: (input: Record<string, unknown>) => string | Promise<string>;
}

export interface ScopeProps {
  /** Absolute priority. */
  p?: number;
  /** Priority relative to the enclosing scope. */
  prel?: number;
  children?: import("react").ReactNode;
}
