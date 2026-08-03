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

/** AI SDK-compatible tool map retained by reference until the target runtime. */
export type AgentToolSet = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Agent Skills

/** Structural Cloudflare Agent Skills metadata; no runtime package dependency. */
export interface AgentSkillDescriptor {
  name: string;
  description: string;
  compatibility?: string;
  license?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  sourceId?: string;
  version?: string;
}

export interface AgentSkillResource {
  path: string;
  kind: "reference" | "script" | "asset" | "file";
  content: string;
  size?: number;
  encoding?: "text" | "base64";
  mimeType?: string;
  precompiled?: boolean;
}

export interface AgentSkillContent extends AgentSkillDescriptor {
  body: string;
  rawContent?: string;
  resources?: Omit<AgentSkillResource, "content">[];
}

/**
 * Target-neutral structural twin of `SkillSource` from `agents/skills`.
 * Cloudflare SkillSource implementations satisfy it directly, without making
 * `agents` a dependency of the authoring package. The current Bun-driven
 * compiler can load importable sources (including `skills.fromManifest(...)`),
 * but not Vite-only `agents:skills` modules or env-bound `skills.r2(...)`.
 */
export interface AgentSkillSource {
  id: string;
  fingerprint: string;
  list(): Promise<AgentSkillDescriptor[]>;
  load(name: string): Promise<AgentSkillContent | null>;
  readResource?(name: string, path: string): Promise<AgentSkillResource | null>;
  refresh?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Model Context Protocol dependencies

/** Portable remote transports supported by Cloudflare Agents. */
export type McpTransport = "auto" | "streamable-http" | "sse";

/**
 * An inert MCP dependency declaration. The compiler validates and carries this
 * descriptor but never connects to the server; target runtimes own the actual
 * client lifecycle.
 */
export interface McpServerDefinition {
  /** Public endpoint or deployment-safe default. Bearer credentials must stay
   * behind a credential-terminating proxy; Agents persists transport options. */
  url: string;
  transport?: McpTransport;
}

/** Server identity comes from the record key, avoiding a duplicated `name`. */
export type McpServerDefinitions = Readonly<Record<string, McpServerDefinition>>;

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
  /** Optional schema for declarative JSX tools. Use an AI SDK tool map when
   * richer metadata (approval policy, provider options, etc.) must survive. */
  inputSchema?: unknown;
  run: (input: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface ScopeProps {
  /** Absolute priority. */
  p?: number;
  /** Priority relative to the enclosing scope. */
  prel?: number;
  children?: import("react").ReactNode;
}
