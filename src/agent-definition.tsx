import type { ReactNode } from "react";
import type {
  AnyAgentSpec,
  BoundarySchema,
  FunctionPropKeys,
  ResolvedAgentDefinition,
} from "./agent-component.tsx";
import { createStore, type AgentStore } from "./store.ts";
import {
  AGENT_DEFINITION_PROMPT_ZONE,
  AGENT_DEFINITION_TOOLS_ZONE,
} from "./tree.ts";
import type {
  AgentSkillSource,
  AgentToolSet,
  McpServerDefinitions,
} from "./types.ts";

/** Runtime brand proving a value came through Agent.define().
 * The registered key keeps the original package identity so values remain
 * interoperable across the namespace migration to `@agent-jsx/core`. */
export const agentDefinitionBrand: unique symbol = Symbol.for(
  "@steventsao/agent-jsx/agent-definition",
) as never;

export interface AgentDefinitionInput<
  P extends object = Record<string, unknown>,
  O = unknown,
> {
  /** Logical provider/model id. A deployment adapter resolves it at runtime. */
  model: string;
  description?: string;
  displayName?: string;
  /** Model input accepted when this agent is exposed as a native agent tool. */
  inputSchema?: BoundarySchema<Omit<P, FunctionPropKeys<P>>>;
  /** Structured result returned when this agent is exposed as a native agent tool. */
  outputSchema?: BoundarySchema<O>;
  /** Plain instructions or priority-aware prompt JSX. */
  prompt?: ReactNode | null;
  /** AI SDK ToolSet (preserved verbatim) or declarative <tool> JSX. */
  tools?: AgentToolSet | ReactNode | null;
  /** Structural `SkillSource` values from Cloudflare `agents/skills`. */
  skills?: readonly AgentSkillSource[];
  /** Remote MCP dependencies. The compiler never connects to them. */
  mcpServers?: McpServerDefinitions;
}

/** The only legal return type of a class-authored Agent.render(). */
export interface AgentDefinition<
  P extends object = Record<string, unknown>,
  O = unknown,
> extends Readonly<AgentDefinitionInput<P, O>> {
  readonly [agentDefinitionBrand]: true;
}

export function createAgentDefinition<P extends object, O>(
  input: AgentDefinitionInput<P, O>,
): AgentDefinition<P, O> {
  const definition = { ...input } as AgentDefinition<P, O>;
  Object.defineProperty(definition, agentDefinitionBrand, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return Object.freeze(definition);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAgentDefinition(value: unknown): value is AgentDefinition<any, any> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<AgentDefinition>)[agentDefinitionBrand] === true
  );
}

function normalizePrompt(value: ReactNode | null | undefined): ReactNode {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") {
    return <prompt><sys p={10}>{value}</sys></prompt>;
  }
  // The boundary ensures unsupported host/UI elements are visited by the
  // prompt collector instead of being silently skipped as unrelated roots.
  return <prompt>{value as any}</prompt>;
}

// Stable cross-package protocol key; do not couple it to the current npm name.
const dataElementBrand = Symbol.for("@steventsao/agent-jsx/data-element");

// Internal string hosts keep definition fields disjoint after components and
// fragments have resolved. `any` prevents these compiler-owned markers from
// becoming part of the public authored intrinsic element interface.
const AgentDefinitionPromptZone = AGENT_DEFINITION_PROMPT_ZONE as any;
const AgentDefinitionToolsZone = AGENT_DEFINITION_TOOLS_ZONE as any;

function isJsxElement(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<PropertyKey, unknown> & {
    $$typeof?: unknown;
    type?: unknown;
    props?: unknown;
  };
  return (
    typeof candidate.type !== "undefined" &&
    typeof candidate.props === "object" &&
    candidate.props !== null &&
    (typeof candidate.$$typeof === "symbol" || candidate[dataElementBrand] === true)
  );
}

function normalizeTools(
  value: AgentToolSet | ReactNode | null | undefined,
  agentName: string,
): { tools: AgentToolSet; tree: ReactNode } {
  if (value == null) return { tools: Object.freeze({}), tree: null };
  if (isJsxElement(value)) {
    return { tools: Object.freeze({}), tree: value as ReactNode };
  }
  if (Array.isArray(value)) {
    if (!value.every((entry) => entry == null || isJsxElement(entry))) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.tools arrays may contain only declarative tool JSX`,
      );
    }
    return { tools: Object.freeze({}), tree: value as ReactNode };
  }
  if (typeof value !== "object") {
    throw new Error(
      `[agent-jsx] agent "${agentName}": definition.tools must be an AI SDK tool map or declarative tool JSX`,
    );
  }

  const toolEntries: Array<[string, unknown]> = [];
  for (const [name, tool] of Object.entries(value)) {
    if (!name.trim() || !tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.tools.${name || "<empty>"} must be an AI SDK tool definition`,
      );
    }
    toolEntries.push([name, tool]);
  }
  return { tools: Object.freeze(Object.fromEntries(toolEntries)), tree: null };
}

/** Mirrors Cloudflare Agents' public `normalizeServerId` contract. */
export function normalizeMcpServerId(input: string): string {
  let id = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (!id || !/^[a-z]/.test(id)) id = `id-${id}`.replace(/-+$/g, "");
  if (id.length > 64) id = id.slice(0, 64).replace(/-+$/g, "");
  return id;
}

const SENSITIVE_MCP_QUERY_KEY_PARTS = [
  "token",
  "apikey",
  "authorization",
  "clientsecret",
  "password",
  "passwd",
  "secret",
  "signature",
] as const;

function isSensitiveMcpQueryKey(name: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return (
    SENSITIVE_MCP_QUERY_KEY_PARTS.some((part) => compact.includes(part)) ||
    compact === "auth" ||
    compact.endsWith("auth") ||
    compact === "pwd" ||
    compact.endsWith("pwd") ||
    compact === "sig" ||
    compact.endsWith("sig")
  );
}

function validateMcpServers(
  servers: McpServerDefinitions | undefined,
  agentName: string,
): McpServerDefinitions {
  if (!servers) return {};
  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(
      `[agent-jsx] agent "${agentName}": definition.mcpServers must be a server-name record`,
    );
  }

  const normalizedEntries: Array<[string, McpServerDefinitions[string]]> = [];
  const namesById = new Map<string, string>();
  for (const [name, server] of Object.entries(servers)) {
    if (!name.trim()) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers contains an empty server name`,
      );
    }
    if (!server || typeof server !== "object" || typeof server.url !== "string") {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers.${name} must be an MCP server descriptor`,
      );
    }
    for (const field of Object.keys(server)) {
      if (field !== "url" && field !== "transport") {
        throw new Error(
          `[agent-jsx] agent "${agentName}": definition.mcpServers.${name}.${field} is not portable; authored MCP descriptors accept only public URL and transport settings`,
        );
      }
    }
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers.${name}.url must be an HTTP URL`,
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers.${name}.url must be an HTTP URL`,
      );
    }
    if (url.username || url.password) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers.${name}.url must not contain credentials; put bearer secrets behind a credential-terminating proxy`,
      );
    }
    if (server.url.includes("#")) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers.${name}.url must not contain a fragment`,
      );
    }
    let hasSensitiveQueryKey = false;
    url.searchParams.forEach((_value, key) => {
      if (isSensitiveMcpQueryKey(key)) hasSensitiveQueryKey = true;
    });
    if (hasSensitiveQueryKey) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers.${name}.url must not contain a sensitive MCP credential query parameter; resolve credentials at deployment time`,
      );
    }
    if (
      server.transport !== undefined &&
      !["auto", "streamable-http", "sse"].includes(server.transport)
    ) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.mcpServers.${name}.transport is unsupported`,
      );
    }
    const id = normalizeMcpServerId(name);
    const collision = namesById.get(id);
    if (collision) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": MCP servers "${collision}" and "${name}" normalize to the same Cloudflare server id "${id}"`,
      );
    }
    namesById.set(id, name);
    normalizedEntries.push([
      name,
      Object.freeze({
        url: url.toString(),
        ...(server.transport ? { transport: server.transport } : {}),
      }),
    ]);
  }
  return Object.freeze(Object.fromEntries(normalizedEntries));
}

/** Validate and lower one render result without performing any external I/O. */
export function normalizeAgentDefinition(
  value: unknown,
  agentName: string,
): ResolvedAgentDefinition {
  if (isPromiseLike(value)) {
    throw new Error(
      `[agent-jsx] agent "${agentName}": render() returned a Promise; agent definitions must be synchronous`,
    );
  }
  if (!isAgentDefinition(value)) {
    throw new Error(
      `[agent-jsx] agent "${agentName}": render() must return this.define({...}); UI elements are not agent definitions`,
    );
  }
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new Error(
      `[agent-jsx] agent "${agentName}": definition.model must contain a non-empty model id`,
    );
  }
  const model = value.model.trim();
  for (const field of ["description", "displayName"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.${field} must be a string when provided`,
      );
    }
  }
  for (const field of ["inputSchema", "outputSchema"] as const) {
    const schema = value[field];
    if (
      schema !== undefined &&
      (!schema || typeof schema !== "object" || typeof schema.parse !== "function")
    ) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.${field} must provide a parse(value) method`,
      );
    }
  }

  const normalizedTools = normalizeTools(value.tools, agentName);
  const skills = Object.freeze([...(value.skills ?? [])]);
  for (const [index, skill] of skills.entries()) {
    if (
      !skill ||
      typeof skill !== "object" ||
      typeof skill.id !== "string" ||
      typeof skill.fingerprint !== "string" ||
      typeof skill.list !== "function" ||
      typeof skill.load !== "function"
    ) {
      throw new Error(
        `[agent-jsx] agent "${agentName}": definition.skills[${index}] must implement the Cloudflare SkillSource contract`,
      );
    }
  }
  const mcpServers = validateMcpServers(value.mcpServers, agentName);
  return {
    model,
    description: value.description,
    displayName: value.displayName,
    inputSchema: value.inputSchema,
    outputSchema: value.outputSchema,
    tools: normalizedTools.tools,
    skills,
    mcpServers,
    tree: (
      <>
        <AgentDefinitionPromptZone>
          {normalizePrompt(value.prompt)}
        </AgentDefinitionPromptZone>
        <AgentDefinitionToolsZone>
          {normalizedTools.tree as any}
        </AgentDefinitionToolsZone>
      </>
    ),
  };
}

/** Resolve either a class definition or a legacy low-level component spec. */
export function resolveAgentSpecDefinition(
  spec: AnyAgentSpec,
  props: Record<string, unknown> = spec.sampleProps ?? {},
  state: Record<string, unknown> = spec.initialState,
): ResolvedAgentDefinition {
  const store = createStore(state);
  if (spec.resolveDefinition) {
    return spec.resolveDefinition(props, store as AgentStore<any>);
  }
  return {
    model: spec.model,
    description: spec.description,
    displayName: spec.displayName,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    tools: {},
    skills: spec.skills ?? [],
    mcpServers: spec.mcpServers ?? {},
    // Low-level component specs are already normalized compiler input. Their
    // implementation may use React hooks, so metadata resolution must not call
    // it outside evaluateTree's static-evaluation boundary.
    tree: null,
  };
}
