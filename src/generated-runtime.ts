/**
 * Compiler-owned runtime assembly.
 *
 * Generated modules describe a graph with plain objects. Effect is deliberately
 * confined to this file: authored agent functions and generated descriptors do
 * not import it, return it, or mention it in their public types. Internally each
 * descriptor becomes a scoped Layer and one ManagedRuntime owns the graph for
 * its whole lifetime.
 */

import { Context, Effect, Layer, ManagedRuntime } from "effect";

type MaybePromise<A> = A | PromiseLike<A>;

export type GeneratedDependencyValues<Requires extends readonly string[]> = Readonly<
  Record<Requires[number], unknown>
>;

/** Values supplied by the compiler-owned adapter when it invokes a render. */
export interface GeneratedRenderContext<Resource, Requires extends readonly string[]> {
  /** The resource acquired for this agent definition. */
  readonly resource: Resource;
  /** Resources provided by the direct `requires` declarations. */
  readonly dependencies: GeneratedDependencyValues<Requires>;
}

/**
 * Plain-data input emitted by the JSX compiler. `render` is intentionally
 * synchronous; acquisition and release are the only async-capable seams.
 */
export interface GeneratedAgentDefinition<
  Name extends string = string,
  Requires extends readonly string[] = readonly string[],
  Resource = unknown,
  Props = unknown,
  Output = unknown,
> {
  readonly name: Name;
  readonly requires: Requires;
  readonly acquire?: (
    dependencies: GeneratedDependencyValues<Requires>,
  ) => MaybePromise<Resource>;
  readonly release?: (resource: Resource) => MaybePromise<void>;
  readonly render: (
    props: Props,
    context: GeneratedRenderContext<Resource, Requires>,
  ) => Output;
}

export type AnyGeneratedAgentDefinition = GeneratedAgentDefinition<
  string,
  readonly string[],
  any,
  any,
  any
>;

/** Preserve literal names and requirements in compiler output. */
export function defineGeneratedAgent<
  const Name extends string,
  const Requires extends readonly string[],
  Resource,
  Props,
  Output,
>(
  definition: GeneratedAgentDefinition<Name, Requires, Resource, Props, Output> &
    (Output extends PromiseLike<unknown>
      ? {
          /** Compiler diagnostic: authored agent functions cannot be async. */
          readonly __asyncAgentFunctionsAreNotSupported: never;
        }
      : unknown),
): GeneratedAgentDefinition<Name, Requires, Resource, Props, Output> {
  return definition;
}

type DefinitionName<Definitions extends readonly AnyGeneratedAgentDefinition[]> =
  Definitions[number]["name"];
type DefinitionRequirements<Definitions extends readonly AnyGeneratedAgentDefinition[]> =
  Definitions[number]["requires"][number];

/** The dependency names not provided by a generated descriptor tuple. */
export type MissingGeneratedDependencies<
  Definitions extends readonly AnyGeneratedAgentDefinition[],
> = Exclude<DefinitionRequirements<Definitions>, DefinitionName<Definitions>>;

type ClosedGraph<Definitions extends readonly AnyGeneratedAgentDefinition[]> =
  [MissingGeneratedDependencies<Definitions>] extends [never]
    ? unknown
    : {
        /** Compiler diagnostic: these required agent definitions are absent. */
        readonly __missingGeneratedDependencies: MissingGeneratedDependencies<Definitions>;
      };

type DefinitionByName<
  Definitions extends readonly AnyGeneratedAgentDefinition[],
  Name extends DefinitionName<Definitions>,
> = Extract<Definitions[number], { readonly name: Name }>;

type ResourceOf<Definition> = Definition extends GeneratedAgentDefinition<
  string,
  readonly string[],
  infer Resource,
  any,
  any
>
  ? Resource
  : never;

type PropsOf<Definition> = Definition extends GeneratedAgentDefinition<
  string,
  readonly string[],
  any,
  infer Props,
  any
>
  ? Props
  : never;

type OutputOf<Definition> = Definition extends GeneratedAgentDefinition<
  string,
  readonly string[],
  any,
  any,
  infer Output
>
  ? Output
  : never;

export interface GeneratedAgentRuntime<
  Definitions extends readonly AnyGeneratedAgentDefinition[],
> {
  /** Read a resource already acquired during async startup. */
  readonly resource: <Name extends DefinitionName<Definitions>>(
    name: Name,
  ) => ResourceOf<DefinitionByName<Definitions, Name>>;
  /** Invoke an authored function synchronously against the cached resources. */
  readonly render: <Name extends DefinitionName<Definitions>>(
    name: Name,
    props: PropsOf<DefinitionByName<Definitions, Name>>,
  ) => OutputOf<DefinitionByName<Definitions, Name>>;
  /** Close the shared scope and run resource finalizers exactly once. */
  readonly dispose: () => Promise<void>;
}

export class MissingGeneratedDependencyError extends Error {
  readonly _tag = "MissingGeneratedDependencyError";

  constructor(
    readonly agentName: string,
    readonly dependencyName: string,
  ) {
    super(
      `[agent-jsx] generated agent "${agentName}" requires "${dependencyName}", ` +
        "but the compiled graph does not provide it",
    );
    this.name = "MissingGeneratedDependencyError";
  }
}

export class DuplicateGeneratedAgentError extends Error {
  readonly _tag = "DuplicateGeneratedAgentError";

  constructor(readonly agentName: string) {
    super(`[agent-jsx] generated graph provides agent "${agentName}" more than once`);
    this.name = "DuplicateGeneratedAgentError";
  }
}

export class CyclicGeneratedDependencyError extends Error {
  readonly _tag = "CyclicGeneratedDependencyError";

  constructor(readonly path: readonly string[]) {
    super(`[agent-jsx] generated agent dependency cycle: ${path.join(" -> ")}`);
    this.name = "CyclicGeneratedDependencyError";
  }
}

export class AgentResourceAcquisitionError extends Error {
  readonly _tag = "AgentResourceAcquisitionError";

  constructor(
    readonly agentName: string,
    options: { cause: unknown },
  ) {
    super(`[agent-jsx] failed to acquire resources for generated agent "${agentName}"`, options);
    this.name = "AgentResourceAcquisitionError";
  }
}

export class AsyncAgentFunctionError extends Error {
  readonly _tag = "AsyncAgentFunctionError";

  constructor(readonly agentName: string) {
    super(
      `[agent-jsx] agent "${agentName}" returned a Promise; agent functions must be synchronous`,
    );
    this.name = "AsyncAgentFunctionError";
  }
}

export class DisposedGeneratedRuntimeError extends Error {
  readonly _tag = "DisposedGeneratedRuntimeError";

  constructor() {
    super("[agent-jsx] generated agent runtime has been disposed");
    this.name = "DisposedGeneratedRuntimeError";
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function validateGraph(
  definitions: readonly AnyGeneratedAgentDefinition[],
): Map<string, AnyGeneratedAgentDefinition> {
  const byName = new Map<string, AnyGeneratedAgentDefinition>();
  for (const definition of definitions) {
    if (!definition.name.trim()) {
      throw new Error("[agent-jsx] generated agent needs a non-empty name");
    }
    if (byName.has(definition.name)) {
      throw new DuplicateGeneratedAgentError(definition.name);
    }
    byName.set(definition.name, definition);
  }

  for (const definition of definitions) {
    for (const dependency of definition.requires) {
      if (!byName.has(dependency)) {
        throw new MissingGeneratedDependencyError(definition.name, dependency);
      }
    }
  }

  const complete = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): void => {
    if (complete.has(name)) return;
    const cycleStart = path.indexOf(name);
    if (active.has(name)) {
      throw new CyclicGeneratedDependencyError([...path.slice(cycleStart), name]);
    }
    active.add(name);
    path.push(name);
    for (const dependency of byName.get(name)!.requires) visit(dependency);
    path.pop();
    active.delete(name);
    complete.add(name);
  };
  for (const definition of definitions) visit(definition.name);
  return byName;
}

type DynamicService = Context.Service<unknown, unknown>;
type DynamicLayer = Layer.Layer<unknown, AgentResourceAcquisitionError, never>;

let runtimeSequence = 0;

/**
 * Build and warm one Effect runtime for a compiler-emitted agent graph. The
 * Promise is a startup boundary only; all later `render` calls are synchronous.
 */
export async function makeGeneratedAgentRuntime<
  const Definitions extends readonly [
    AnyGeneratedAgentDefinition,
    ...AnyGeneratedAgentDefinition[],
  ],
>(
  definitions: Definitions & ClosedGraph<Definitions>,
): Promise<GeneratedAgentRuntime<Definitions>> {
  const byName = validateGraph(definitions);
  const namespace = ++runtimeSequence;
  const tags = new Map<string, DynamicService>();
  const layers = new Map<string, DynamicLayer>();

  for (const definition of definitions) {
    tags.set(
      definition.name,
      Context.Service<unknown>(`@agent-jsx/generated/${namespace}/${definition.name}`),
    );
  }

  const assemble = (name: string): DynamicLayer => {
    const cached = layers.get(name);
    if (cached) return cached;

    const definition = byName.get(name)!;
    const tag = tags.get(name)!;
    const acquire = Effect.gen(function* () {
      const dependencies: Record<string, unknown> = Object.create(null);
      for (const dependency of definition.requires) {
        dependencies[dependency] = yield* Effect.service(tags.get(dependency)!);
      }

      return yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Promise.resolve(definition.acquire?.(dependencies)),
          catch: (cause) => new AgentResourceAcquisitionError(name, { cause }),
        }),
        (resource) =>
          Effect.promise(() => Promise.resolve(definition.release?.(resource)).then(() => undefined)),
      );
    });

    // The dynamic keys are type-erased here because their exact union is
    // compiler data. Runtime identity is retained by the stable tag objects;
    // `ClosedGraph` and `validateGraph` enforce the same relationship at the
    // generated TypeScript and JavaScript boundaries respectively.
    const own = Layer.effect(
      tag,
      acquire as Effect.Effect<unknown, AgentResourceAcquisitionError, never>,
    ) as DynamicLayer;
    const dependencyLayers = definition.requires.map(assemble);
    const assembled =
      dependencyLayers.length === 0
        ? own
        : (Layer.provideMerge(
            own,
            dependencyLayers.length === 1
              ? dependencyLayers[0]!
              : Layer.mergeAll(
                  ...(dependencyLayers as [DynamicLayer, ...DynamicLayer[]]),
                ),
          ) as DynamicLayer);
    layers.set(name, assembled);
    return assembled;
  };

  const allLayers = definitions.map((definition) => assemble(definition.name)) as [
    DynamicLayer,
    ...DynamicLayer[],
  ];
  const runtime = ManagedRuntime.make(Layer.mergeAll(...allLayers));
  let context: Context.Context<unknown>;
  try {
    context = await runtime.context();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }

  const resources = new Map<string, unknown>();
  for (const definition of definitions) {
    resources.set(definition.name, Context.getUnsafe(context, tags.get(definition.name)!));
  }

  let disposed = false;
  const assertLive = (): void => {
    if (disposed) throw new DisposedGeneratedRuntimeError();
  };

  return {
    resource(name) {
      assertLive();
      return resources.get(name) as never;
    },
    render(name, props) {
      assertLive();
      const definition = byName.get(name)!;
      const dependencies: Record<string, unknown> = Object.create(null);
      for (const dependency of definition.requires) {
        dependencies[dependency] = resources.get(dependency);
      }
      const output = definition.render(props, {
        resource: resources.get(name),
        dependencies,
      });
      if (isThenable(output)) throw new AsyncAgentFunctionError(name);
      return output;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await runtime.dispose();
    },
  } as GeneratedAgentRuntime<Definitions>;
}
