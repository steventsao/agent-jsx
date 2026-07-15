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

/** Sweep the committed tree into a flat desired-infra list, keyed by identity. */
export function collectInfra(node: HostNode | null, out: InfraRecord[] = []): InfraRecord[] {
  if (!node) return out;
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
    if (node.type === "prompt") for (const child of node.children) walk(child, BASE, "user");
    else for (const child of node.children) findPrompts(child);
  };
  for (const root of roots) findPrompts(root);
  return blocks;
}
