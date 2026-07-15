import {
  agentComponent,
  type AgentBoundaryProps,
  type AgentClass as BoundaryAgentClass,
  type AgentSpec,
} from "./agent-component.tsx";
import {
  bindCallable,
  callable,
  callableMetadata,
  result,
  type CallableRef,
} from "./callable.ts";
import type { AgentStore } from "./store.ts";

export { callable, result, type CallableRef } from "./callable.ts";

type AnyMethod = (...args: any[]) => any;
type AnyState = Record<string, unknown>;
type AnyProps = object;
type AgentNode = ReturnType<BoundaryAgentClass<any, any, any>>;

interface BoundContext<S extends AnyState, P extends AnyProps> {
  store: AgentStore<S>;
  props: P;
}

/**
 * Target-neutral, Cloudflare/agents-style authoring base.
 *
 * `render()` is UI-only and is deliberately absent from compiler evaluation.
 * Agent context comes from getPrompt/getTools/getSkills; durable behavior uses
 * state/setState and explicitly callable methods.
 */
export abstract class Agent<
  S extends AnyState,
  P extends AnyProps = {},
> {
  /** Type-only carrier used by the compiler API; no runtime field is emitted. */
  declare readonly __agentTypes: { state: S; props: P };
  abstract initialState: S;
  abstract model: string;
  description?: string;
  displayName?: string;

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

  /** Priompt JSX or a plain string. */
  getPrompt(): AgentNode | string | null {
    return null;
  }

  /** AI SDK-style object or declarative <tool> JSX. */
  getTools(): Record<string, unknown> | AgentNode | null {
    return null;
  }

  getSkills(): readonly unknown[] {
    return [];
  }

  /** Optional UI projection only. Codegen never treats this as agent context. */
  render(): AgentNode {
    return null;
  }

  /** @internal compiler binding seam. */
  __bind(store: AgentStore<S>, props: P): this {
    this.#bound = { store, props };
    return this;
  }
}

export interface AgentDefinition<I extends Agent<any, any> = Agent<any, any>> {
  new (): I;
  agentName: string;
}

type InstanceOf<C> = C extends AgentDefinition<infer I> ? I : never;
type StateOf<C> = InstanceOf<C>["__agentTypes"]["state"];
type PropsOf<C> = InstanceOf<C>["__agentTypes"]["props"];

type AuthorMemberKeys<C extends AgentDefinition<any>> = Exclude<
  keyof InstanceOf<C>,
  keyof Agent<any, any>
>;

export type AgentBindings<C extends AgentDefinition<any>> = {
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

export type CompiledAgentClass<C extends AgentDefinition<any>> = ((
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

function normalizePrompt(value: AgentNode | string | null): AgentNode {
  if (typeof value === "string") return <prompt><sys p={10}>{value}</sys></prompt>;
  return value;
}

function normalizeTools(value: Record<string, unknown> | AgentNode | null): AgentNode {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ("type" in value && "props" in value)
  ) return value as AgentNode;
  return Object.entries(value).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const definition = raw as {
      description?: unknown;
      execute?: unknown;
      run?: unknown;
    };
    const run = typeof definition.execute === "function"
      ? definition.execute
      : typeof definition.run === "function"
        ? definition.run
        : undefined;
    if (!run) return [];
    return [
      <tool
        key={name}
        name={name}
        description={String(definition.description ?? "")}
        run={run as (input: Record<string, unknown>) => string | Promise<string>}
      />,
    ];
  });
}

/** Compiler lowering for one hierarchy-free authored class. */
export function compileAgentClass<C extends AgentDefinition<any>>(
  Definition: C,
): CompiledAgentClass<C> {
  type S = StateOf<C>;
  type P = PropsOf<C>;
  type I = InstanceOf<C>;
  const detached = new Definition() as I;
  if (!Definition.agentName) throw new Error("[agent-jsx] Agent class needs static agentName");
  if (!detached.model) throw new Error(`[agent-jsx] Agent class "${Definition.agentName}" needs model`);

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

  const spec = {
    agentName: Definition.agentName,
    model: detached.model,
    description: detached.description,
    displayName: detached.displayName,
    initialState: detached.initialState,
    skills: detached.getSkills(),
    impl: ({ store, emit: _emit, ...props }: P & {
      store: AgentStore<S>;
      emit?: (output: unknown) => void | Promise<void>;
    }) => {
      const instance = instantiate(props as unknown as P, store);
      return (
        <>
          {normalizePrompt(instance.getPrompt())}
          {normalizeTools(instance.getTools())}
        </>
      );
    },
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

type AnyCompiledClass = CompiledAgentClass<AgentDefinition<any>>;

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
  const spec = {
    ...base,
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
