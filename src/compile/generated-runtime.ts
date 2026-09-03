/**
 * Prototype lowering from authored JSX functions to the compiler-owned runtime.
 *
 * `discoverAgents` evaluates the same pure component samples used by the other
 * emitters. Each component provides its own agent name and requires the direct
 * child kinds found in its rendered JSX. This module contains no Effect API;
 * it feeds the stable plain-data adapter in `../generated-runtime.ts`.
 */

import type { ReactNode } from "react";
import type { AgentRenderProps } from "../agent-component.tsx";
import {
  defineGeneratedAgent,
  makeGeneratedAgentRuntime,
  type AnyGeneratedAgentDefinition,
} from "../generated-runtime.ts";
import { discoverAgents, type AgentModule, type AgentNode } from "./graph.ts";

export interface GeneratedAgentManifestEntry {
  /** Service provided by this component's generated layer. */
  readonly provides: string;
  /** Direct child services inferred from rendered JSX boundaries. */
  readonly requires: readonly string[];
  readonly exportName: string;
  readonly importPath: string;
}

export interface GeneratedAgentManifest {
  readonly root: string;
  readonly agents: readonly GeneratedAgentManifestEntry[];
}

export class UnresolvedGeneratedAgentError extends Error {
  readonly _tag = "UnresolvedGeneratedAgentError";

  constructor(
    readonly parentName: string,
    readonly childName: string,
  ) {
    super(
      `[agent-jsx] agent "${parentName}" renders child "${childName}", ` +
        "but no matching agent module was registered",
    );
    this.name = "UnresolvedGeneratedAgentError";
  }
}

function discoverClosedGraph(root: AgentModule, registry: readonly AgentModule[]): AgentNode[] {
  const nodes = discoverAgents(root, [...registry]);
  const provided = new Set(nodes.map((node) => node.spec.agentName));
  for (const node of nodes) {
    for (const child of node.directChildren) {
      if (!provided.has(child)) {
        throw new UnresolvedGeneratedAgentError(node.spec.agentName, child);
      }
    }
  }
  return nodes;
}

/** Infer the layer-shaped dependency declaration from authored React functions. */
export function compileGeneratedAgentManifest(
  root: AgentModule,
  registry: readonly AgentModule[],
): GeneratedAgentManifest {
  const nodes = discoverClosedGraph(root, registry);
  return {
    root: root.spec.agentName,
    agents: nodes.map((node) => ({
      provides: node.spec.agentName,
      requires: node.directChildren,
      exportName: node.exportName,
      importPath: node.importPath,
    })),
  };
}

export interface CompiledAgentResourceFactory {
  readonly acquire?: (
    dependencies: Readonly<Record<string, unknown>>,
  ) => unknown | PromiseLike<unknown>;
  readonly release?: (resource: unknown) => void | PromiseLike<void>;
}

type CompiledDefinitions = readonly [
  AnyGeneratedAgentDefinition,
  ...AnyGeneratedAgentDefinition[],
];

/** Dynamic bridge used before source emission; emitted literal descriptors use
 * the more precise `GeneratedAgentRuntime` name/props mapping. */
export interface CompiledAgentRuntime {
  readonly resource: (name: string) => unknown;
  readonly render: (
    name: string,
    props: AgentRenderProps<any, any, any>,
  ) => ReactNode;
  readonly dispose: () => Promise<void>;
}

/**
 * Execute the prototype lowering directly. Production emitters will serialize
 * the same manifest as literal `defineGeneratedAgent(...)` declarations.
 */
export async function makeCompiledAgentRuntime(
  root: AgentModule,
  registry: readonly AgentModule[],
  resources: Readonly<Record<string, CompiledAgentResourceFactory>> = {},
): Promise<CompiledAgentRuntime> {
  const nodes = discoverClosedGraph(root, registry);
  const definitions = nodes.map((node) => {
    const name = node.spec.agentName;
    const factory = resources[name];
    return defineGeneratedAgent({
      name,
      requires: node.directChildren,
      acquire: factory?.acquire,
      release: factory?.release,
      render: (props: AgentRenderProps<any, any, any>): ReactNode => node.spec.impl(props),
    });
  }) as unknown as CompiledDefinitions;

  // Runtime graph discovery is necessarily value-driven; `discoverClosedGraph`
  // performs the same closed-world check that literal generated tuples receive
  // from `MissingGeneratedDependencies` in emitted TypeScript.
  return makeGeneratedAgentRuntime(
    definitions as CompiledDefinitions & any,
  ) as Promise<CompiledAgentRuntime>;
}
