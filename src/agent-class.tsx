import {
  agentComponent,
  type AgentBoundaryProps,
  type AgentClass as BoundaryAgentClass,
  type ResolvedAgentDefinition,
  type AgentSpec,
} from "./agent-component.tsx";
import {
  bindCallable,
  callable,
  callableMetadata,
  result,
  type CallableRef,
} from "./callable.ts";
import {
  createAgentDefinition,
  normalizeAgentDefinition,
  type AgentDefinition,
  type AgentDefinitionInput,
} from "./agent-definition.tsx";
import { createStore, type AgentStore } from "./store.ts";

export { callable, result, type CallableRef } from "./callable.ts";
export type { AgentDefinition, AgentDefinitionInput } from "./agent-definition.tsx";
export type {
  AgentSkillSource,
  AgentToolSet,
  McpServerDefinition,
  McpServerDefinitions,
  McpTransport,
} from "./types.ts";

type AnyMethod = (...args: any[]) => any;
type AnyState = Record<string, unknown>;
type AnyProps = object;
type AgentNode = ReturnType<BoundaryAgentClass<any, any, any>>;
const REMOVED_DEFINITION_MEMBERS = [
  "model",
  "description",
  "displayName",
  "getPrompt",
  "getTools",
  "getSkills",
] as const;
type RemovedDefinitionMember = (typeof REMOVED_DEFINITION_MEMBERS)[number];

interface BoundContext<S extends AnyState, P extends AnyProps> {
  store: AgentStore<S>;
  props: P;
}

/**
 * Target-neutral, Cloudflare/agents-style authoring base. `render()` declares
 * the complete model-facing definition; durable behavior remains ordinary
 * state/setState plus explicitly callable methods.
 */
export abstract class Agent<
  S extends AnyState,
  P extends AnyProps = {},
> {
  /** Type-only carrier used by the compiler API; no runtime field is emitted. */
  declare readonly __agentTypes: { state: S; props: P };
  abstract initialState: S;
  abstract render(): AgentDefinition<P, any>;

  #bound?: BoundContext<S, P>;
  #detachedState?: S;

  get state(): S {
    return this.#bound?.store.get() ?? this.#detachedState ?? this.initialState;
  }

  get props(): P {
    return this.#bound?.props ?? ({} as P);
  }

  setState(next: S | ((state: S) => S)): void {
    if (this.#bound) {
      this.#bound.store.set(next);
      return;
    }
    this.#detachedState = typeof next === "function" ? next(this.state) : next;
  }

  /** Brand and type-check the sole legal render result. */
  protected define<O = unknown>(
    definition: AgentDefinitionInput<P, O>,
  ): AgentDefinition<P, O> {
    return createAgentDefinition(definition);
  }

  /** @internal compiler binding seam. */
  __bind(store: AgentStore<S>, props: P): this {
    this.#bound = { store, props };
    return this;
  }
}

export interface AgentConstructor<I extends Agent<any, any> = Agent<any, any>> {
  new (): I;
  agentName: string;
}

type InstanceOf<C> = C extends AgentConstructor<infer I> ? I : never;
type StateOf<C> = InstanceOf<C>["__agentTypes"]["state"];
type PropsOf<C> = InstanceOf<C>["__agentTypes"]["props"];

type AuthorMemberKeys<C extends AgentConstructor<any>> = Exclude<
  keyof InstanceOf<C>,
  keyof Agent<any, any> | RemovedDefinitionMember
>;

export type AgentBindings<C extends AgentConstructor<any>> = {
  [K in AuthorMemberKeys<C>]: InstanceOf<C>[K] extends AnyMethod
    ? CallableRef<InstanceOf<C>[K]>
    : InstanceOf<C>[K];
};

interface ClassSpecRuntime<P extends AnyProps, S extends AnyState> {
  callableMethods: string[];
  createBindings(props: P, store: AgentStore<S>): Record<string, unknown>;
  invokeCallable(
    method: string,
    props: P,
    store: AgentStore<S>,
    args: unknown[],
  ): unknown | Promise<unknown>;
}

export type CompiledAgentClass<C extends AgentConstructor<any>> = ((
  props: PropsOf<C> & AgentBoundaryProps & {
    children?: (bindings: AgentBindings<C>) => AgentNode;
  },
) => AgentNode) & {
  spec: AgentSpec<PropsOf<C>, StateOf<C>> & ClassSpecRuntime<PropsOf<C>, StateOf<C>>;
  definition: C;
  readonly __agentContract: {
    props: PropsOf<C>;
    state: StateOf<C>;
    output: unknown;
  };
};

function prototypesUntilAgent(value: object): object[] {
  const prototypes: object[] = [];
  let prototype = Object.getPrototypeOf(value) as object | null;
  while (prototype && prototype !== Agent.prototype) {
    prototypes.push(prototype);
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return prototypes;
}

function removedDefinitionMembers(value: Agent<any, any>): RemovedDefinitionMember[] {
  const declared = new Set(Object.getOwnPropertyNames(value));
  for (const prototype of prototypesUntilAgent(value)) {
    for (const name of Object.getOwnPropertyNames(prototype)) declared.add(name);
  }
  return REMOVED_DEFINITION_MEMBERS.filter((name) => declared.has(name));
}

function assertDefinitionMigration(value: Agent<any, any>, agentName: string): void {
  const removed = removedDefinitionMembers(value);
  if (!removed.length) return;
  throw new Error(
    `[agent-jsx] Agent class "${agentName}" still declares removed members: ${removed.join(", ")}. ` +
      "Move model, metadata, prompt, tools, skills, and MCP servers into render() { return this.define({...}) }.",
  );
}

function callableNames(value: Agent<any, any>): string[] {
  const names: string[] = [];
  for (const prototype of prototypesUntilAgent(value)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || names.includes(name)) continue;
      const member = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (typeof member === "function" && callableMetadata(member)) names.push(name);
    }
  }
  return names;
}

function createBindings<S extends AnyState, P extends AnyProps>(
  instance: Agent<S, P>,
): Record<string, unknown> {
  const bindings: Record<string, unknown> = {};
  for (const prototype of prototypesUntilAgent(instance)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === "constructor" || name in bindings) continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor?.get) {
        bindings[name] = descriptor.get.call(instance);
      } else if (typeof descriptor?.value === "function") {
        const metadata = callableMetadata(descriptor.value);
        if (metadata) bindings[name] = bindCallable(descriptor.value, instance, metadata);
      }
    }
  }
  return bindings;
}

interface StaticAgentDefinition {
  model: string;
  description?: string;
  displayName?: string;
  inputSchema?: ResolvedAgentDefinition["inputSchema"];
  outputSchema?: ResolvedAgentDefinition["outputSchema"];
  skills: readonly unknown[];
  mcpServers: ResolvedAgentDefinition["mcpServers"];
}

function staticDefinitionOf(definition: ResolvedAgentDefinition): StaticAgentDefinition {
  return {
    model: definition.model as string,
    description: definition.description,
    displayName: definition.displayName,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    skills: definition.skills,
    mcpServers: definition.mcpServers,
  };
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  const leftIsPlain = leftPrototype === Object.prototype || leftPrototype === null;
  const rightIsPlain = rightPrototype === Object.prototype || rightPrototype === null;
  if (!leftIsPlain || !rightIsPlain) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

const NO_SCHEMA_SHAPE = Symbol("no-schema-shape");

/**
 * Prefer a schema's portable declaration over object identity. Zod 4 exposes
 * this directly and produces plain JSON Schema, so two equivalent inline
 * declarations compare equal while genuinely different contracts still fail
 * the static-definition check. Opaque schemas retain the conservative
 * reference-identity behavior.
 */
function portableSchemaShape(schema: unknown): unknown | typeof NO_SCHEMA_SHAPE {
  if (!schema || typeof schema !== "object") return NO_SCHEMA_SHAPE;
  const record = schema as Record<string, unknown>;
  if (typeof record.toJSONSchema === "function") {
    try {
      return (record.toJSONSchema as () => unknown).call(schema);
    } catch {
      return NO_SCHEMA_SHAPE;
    }
  }
  if (record.jsonSchema && typeof record.jsonSchema === "object") {
    return record.jsonSchema;
  }
  return NO_SCHEMA_SHAPE;
}

function schemasEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const leftShape = portableSchemaShape(left);
  const rightShape = portableSchemaShape(right);
  return (
    leftShape !== NO_SCHEMA_SHAPE &&
    rightShape !== NO_SCHEMA_SHAPE &&
    structurallyEqual(leftShape, rightShape)
  );
}

/** SkillSource deliberately exposes stable id + fingerprint metadata so an
 * author may construct an equivalent source object inside render() without
 * making the declared skill contract appear dynamic. */
function skillsEquivalent(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const other = right[index];
    if (!value || !other || typeof value !== "object" || typeof other !== "object") {
      return Object.is(value, other);
    }
    const source = value as { id?: unknown; fingerprint?: unknown };
    const candidate = other as { id?: unknown; fingerprint?: unknown };
    return source.id === candidate.id && source.fingerprint === candidate.fingerprint;
  });
}

function changedStaticField(
  baseline: StaticAgentDefinition,
  next: StaticAgentDefinition,
): keyof StaticAgentDefinition | null {
  for (const key of ["model", "description", "displayName"] as const) {
    if (baseline[key] !== next[key]) return key;
  }
  for (const key of ["inputSchema", "outputSchema"] as const) {
    if (!schemasEquivalent(baseline[key], next[key])) return key;
  }
  if (!skillsEquivalent(baseline.skills, next.skills)) return "skills";
  if (!structurallyEqual(baseline.mcpServers, next.mcpServers)) return "mcpServers";
  return null;
}

/** Compiler lowering for one hierarchy-free authored class. */
export function compileAgentClass<C extends AgentConstructor<any>>(
  Definition: C,
): CompiledAgentClass<C> {
  type S = StateOf<C>;
  type P = PropsOf<C>;
  type I = InstanceOf<C>;
  const detached = new Definition() as I;
  if (!Definition.agentName) throw new Error("[agent-jsx] Agent class needs static agentName");
  assertDefinitionMigration(detached, Definition.agentName);

  const methods = callableNames(detached);
  const instantiate = (props: P, store: AgentStore<S>) =>
    (new Definition() as I).__bind(store, props);
  const runtime: ClassSpecRuntime<P, S> = {
    callableMethods: methods,
    createBindings(props, store) {
      return createBindings(instantiate(props, store));
    },
    invokeCallable(method, props, store, args) {
      const instance = instantiate(props, store) as I & Record<string, unknown>;
      const target = instance[method];
      if (typeof target !== "function" || !methods.includes(method)) {
        throw new Error(`[agent-jsx] "${Definition.agentName}.${method}" is not decorated with callable()`);
      }
      return (target as AnyMethod).apply(instance, args);
    },
  };

  let baseline: StaticAgentDefinition | undefined;
  let spec: AgentSpec<P, S> & ClassSpecRuntime<P, S>;
  const resolveDefinition = (props: P, store: AgentStore<S>) => {
    const instance = instantiate(props, store);
    const definition = normalizeAgentDefinition(instance.render(), Definition.agentName);
    const next = staticDefinitionOf(definition);
    if (baseline) {
      const changed = changedStaticField(baseline, next);
      if (changed) {
        throw new Error(
          `[agent-jsx] agent "${Definition.agentName}": static definition field "${changed}" changed between renders`,
        );
      }
    } else {
      baseline = next;
    }
    spec.sampleProps ??= props;
    // Preserve the low-level AgentSpec metadata surface for existing compiler
    // consumers after the first real/sample definition evaluation.
    spec.model = definition.model;
    spec.description = definition.description;
    spec.displayName = definition.displayName;
    spec.inputSchema = definition.inputSchema;
    spec.outputSchema = definition.outputSchema;
    spec.skills = definition.skills;
    spec.mcpServers = definition.mcpServers;
    return definition;
  };

  spec = {
    agentName: Definition.agentName,
    initialState: detached.initialState,
    resolveDefinition,
    impl: ({ store, emit: _emit, ...props }: P & {
      store: AgentStore<S>;
      emit?: (output: unknown) => void | Promise<void>;
    }) => resolveDefinition(props as unknown as P, store).tree,
    ...runtime,
  } as unknown as AgentSpec<P, S> & ClassSpecRuntime<P, S>;

  // Preserve boundary identity: provider registries and workflow descriptors
  // use the exported compiled function itself as private, non-serializable
  // metadata. A wrapper here would make descriptor.target unexpectedly differ.
  const Compiled = agentComponent(spec) as unknown as CompiledAgentClass<C>;
  Compiled.spec = spec as CompiledAgentClass<C>["spec"];
  Compiled.definition = Definition;
  return Compiled;
}

type AnyCompiledClass = CompiledAgentClass<AgentConstructor<any>>;

interface CompiledAgentElement<C extends AnyCompiledClass> {
  type: C;
  props: Parameters<C>[0];
}

/**
 * Make a class agent the root of a composition. The function child receives
 * only the root's explicit getter/callable surface and returns ordinary agent
 * JSX; that returned tree is the generated hierarchy.
 */
export function composeAgent<C extends AnyCompiledClass>(
  element: CompiledAgentElement<C>,
): BoundaryAgentClass<{}, C["spec"]["initialState"]>;
/** React-free JSX runtimes intentionally erase an element's component type.
 * Child props are still checked at the JSX site; this overload accepts that
 * data element while the runtime validates the compiled root shape. */
export function composeAgent(element: AgentNode): BoundaryAgentClass<{}, any>;
export function composeAgent(
  element: CompiledAgentElement<AnyCompiledClass> | AgentNode,
): BoundaryAgentClass<{}, any> {
  const typed = element as CompiledAgentElement<AnyCompiledClass>;
  const Root = typed.type;
  const { name: _name, children, ...rootProps } = typed.props;
  if (typeof children !== "function") {
    throw new Error("[agent-jsx] composeAgent root needs a function child");
  }
  const base = Root.spec;
  type RootState = typeof base.initialState;
  const rootDefinition = base.resolveDefinition?.(
    rootProps as never,
    createStore(base.initialState),
  );
  const spec = {
    ...base,
    ...(rootDefinition
      ? {
          model: rootDefinition.model,
          description: rootDefinition.description,
          displayName: rootDefinition.displayName,
          inputSchema: rootDefinition.inputSchema,
          outputSchema: rootDefinition.outputSchema,
          skills: rootDefinition.skills,
          mcpServers: rootDefinition.mcpServers,
          resolveDefinition: (_props: {}, store: AgentStore<RootState>) =>
            base.resolveDefinition!(rootProps as never, store),
        }
      : {}),
    sampleProps: {},
    impl: ({ store }: { store: AgentStore<RootState> }) => (
      <>
        {base.impl({ ...(rootProps as object), store, emit: () => {} } as never)}
        {(children as (bindings: Record<string, unknown>) => AgentNode)(
          base.createBindings(rootProps as never, store),
        )}
      </>
    ),
  } as unknown as AgentSpec<{}, RootState> & ClassSpecRuntime<{}, RootState>;
  return agentComponent(spec);
}
