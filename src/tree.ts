/**
 * React-free host tree: the committed-tree shape plus the two sweeps that turn
 * it into desired agent state.
 *
 * This module deliberately imports NOTHING from react or react-reconciler, so
 * it can ship inside a compiled artifact (a cloudflare/agents DO, a flue
 * module) whose runtime never loads the reconciler. `reconciler.ts` re-exports
 * these for the dev/React path; `compile/evaluate.ts` produces the same
 * `HostNode` shape by walking elements by hand.
 */

import type { InfraKind, InfraRecord, PromptBlock } from "./types.ts";

export interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: HostNode[];
}

const INFRA_KINDS = new Set<string>(["sensor", "schedule", "subagent", "tool", "task"]);
/** Compiler-owned host markers that keep class definition fields disjoint. */
export const AGENT_DEFINITION_PROMPT_ZONE = "agent-definition-prompt-zone";
export const AGENT_DEFINITION_TOOLS_ZONE = "agent-definition-tools-zone";
const DEFINITION_HOST_KINDS = new Set<string>([
  ...INFRA_KINDS,
  AGENT_DEFINITION_PROMPT_ZONE,
  AGENT_DEFINITION_TOOLS_ZONE,
  "prompt",
  "sys",
  "msg",
  "scope",
  "text",
  // Goal declaration. NOT an infra kind: it reconciles to no record.
  "phase",
]);
const PROMPT_HOST_KINDS = new Set(["prompt", "sys", "msg", "scope", "text"]);

function validatePromptZone(node: HostNode): void {
  const validate = (child: HostNode): void => {
    if (!PROMPT_HOST_KINDS.has(child.type)) {
      throw new Error(
        `[agent-jsx] agent definition.prompt may contain only prompt JSX and text; found <${child.type}>`,
      );
    }
    for (const nested of child.children) validate(nested);
  };
  for (const child of node.children) validate(child);
}

function validateToolsZone(node: HostNode): void {
  for (const child of node.children) {
    if (child.type !== "tool") {
      throw new Error(
        `[agent-jsx] agent definition.tools may contain only declarative <tool> nodes; found <${child.type}>`,
      );
    }
    if (child.children.length > 0) {
      throw new Error(
        `[agent-jsx] agent definition.tools may contain only declarative <tool> nodes; <tool> must not have children`,
      );
    }
  }
}

/** Sweep the committed tree into a flat desired-infra list, keyed by identity. */
export function collectInfra(node: HostNode | null, out: InfraRecord[] = []): InfraRecord[] {
  if (!node) return out;
  if (node.type === AGENT_DEFINITION_PROMPT_ZONE) {
    validatePromptZone(node);
    return out;
  }
  if (node.type === AGENT_DEFINITION_TOOLS_ZONE) {
    validateToolsZone(node);
    for (const child of node.children) collectInfra(child, out);
    return out;
  }
  if (!DEFINITION_HOST_KINDS.has(node.type)) {
    throw new Error(
      `[agent-jsx] unsupported host element <${node.type}>; agent definitions cannot render UI`,
    );
  }
  if (INFRA_KINDS.has(node.type)) {
    const { name, __agentBindings, __agentTarget, ...rest } = node.props as {
      name?: unknown;
      __agentBindings?: unknown;
      __agentTarget?: unknown;
    };
    if (typeof name !== "string" || !name) {
      throw new Error(`<${node.type}> requires a stable string \`name\` prop (host-level identity)`);
    }
    const config: Record<string, unknown> = {};
    const handlers: InfraRecord["handlers"] = {};
    for (const [k, v] of Object.entries(rest)) {
      if (typeof v === "function") handlers[k] = v as (...args: any[]) => unknown;
      else config[k] = v;
    }
    const bindings =
      node.type === "subagent" &&
      typeof __agentBindings === "object" &&
      __agentBindings !== null
        ? (__agentBindings as InfraRecord["bindings"])
        : undefined;
    const target =
      node.type === "subagent" &&
      (typeof __agentTarget === "object" || typeof __agentTarget === "function") &&
      __agentTarget !== null
        ? (__agentTarget as object)
        : undefined;
    out.push({
      kind: node.type as InfraKind,
      name,
      config,
      handlers,
      ...(bindings ? { bindings } : {}),
      ...(target ? { target } : {}),
    });
  }
  for (const child of node.children) collectInfra(child, out);
  return out;
}

/** One `<phase>` declaration, swept out of a committed tree as plain data. */
export interface CollectedPhase {
  name: string;
  /** Outgoing edges: child-local outcome name -> target phase name. */
  on: Record<string, string>;
  /** Marks the goal's entry phase. */
  initial: boolean;
}

/**
 * Sweep the committed tree into the declared goal graph.
 *
 * The twin of `collectInfra`, and deliberately a SEPARATE sweep: `<phase>`
 * produces no `InfraRecord` because a phase is not a durable capability — it is
 * a node of a transition graph. Everything a phase declares is serializable
 * (`name`, an `on` map of outcome -> target NAME), so this sweep hands
 * `buildGoalTable` the whole machine as data, before anything runs and without
 * ever capturing a closure. A `<phase>`'s children are still walked, so a
 * provider that mounts only the active fragment reports every declared phase
 * either way.
 */
export function collectPhases(node: HostNode | null, out: CollectedPhase[] = []): CollectedPhase[] {
  if (!node) return out;
  if (node.type === "phase") {
    const { name, on, initial } = node.props as {
      name?: unknown;
      on?: unknown;
      initial?: unknown;
    };
    if (typeof name !== "string" || !name) {
      throw new Error("<phase> requires a stable string `name` prop (the goal-machine state key)");
    }
    const edges: Record<string, string> = {};
    for (const [event, target] of Object.entries((on ?? {}) as Record<string, unknown>)) {
      if (typeof target !== "string" || !target) {
        throw new Error(
          `<phase name="${name}"> edge "${event}" must name a target phase (a serializable string), not ${typeof target}`
        );
      }
      edges[event] = target;
    }
    out.push({ name, on: edges, initial: initial === true });
  }
  for (const child of node.children) collectPhases(child, out);
  return out;
}

/** Resolve the one explicitly declared delegate-result sink for a boundary. */
export function resultBindingName(record: InfraRecord): string | null {
  const names = Object.entries(record.bindings ?? {})
    .filter(([, binding]) => binding.kind === "result")
    .map(([name]) => name);
  if (names.length > 1) {
    throw new Error(
      `[agent-jsx] subagent "${record.name}" declares multiple result bindings (${names.join(", ")})`
    );
  }
  return names[0] ?? null;
}

/** Flatten the committed <prompt> subtree into priority-tagged blocks. */
export function collectPrompt(roots: HostNode[]): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  const BASE = 5; // default priority for untagged content

  const textOf = (node: HostNode): string =>
    node.type === "text"
      ? String(node.props.value)
      : node.children.map(textOf).join("");

  const walk = (node: HostNode, parentPriority: number, role: "system" | "user") => {
    if (!PROMPT_HOST_KINDS.has(node.type)) {
      throw new Error(
        `[agent-jsx] unsupported host element <${node.type}>; agent definitions cannot render UI`,
      );
    }
    const p = node.props.p as number | undefined;
    const prel = node.props.prel as number | undefined;
    const effective = p !== undefined ? p : parentPriority + (prel ?? 0);
    const nodeRole = node.type === "sys" ? "system" : node.type === "msg" ? "user" : role;

    if (node.type === "sys" || node.type === "msg") {
      const text = textOf(node).trim();
      if (text) blocks.push({ priority: effective, role: nodeRole, text });
      return;
    }
    for (const child of node.children) walk(child, effective, nodeRole);
  };

  const findPrompts = (node: HostNode | null) => {
    if (!node) return;
    if (node.type === AGENT_DEFINITION_PROMPT_ZONE) {
      validatePromptZone(node);
      for (const child of node.children) findPrompts(child);
      return;
    }
    if (node.type === AGENT_DEFINITION_TOOLS_ZONE) {
      validateToolsZone(node);
      return;
    }
    if (node.type === "prompt") for (const child of node.children) walk(child, BASE, "user");
    else for (const child of node.children) findPrompts(child);
  };
  for (const root of roots) findPrompts(root);
  return blocks;
}
