import type {
  AgentCapabilityDeclaration,
  AgentCapabilityKind,
} from "./agent-component.tsx";

type AnyMethod = (...args: any[]) => any;

export interface CallableMetadata {
  /** How this callable behaves when explicitly passed across an agent boundary. */
  kind?: AgentCapabilityKind;
}

const callableMethods = new WeakMap<AnyMethod, CallableMetadata>();
const CALLABLE_REF = Symbol.for("agent-jsx.callable-ref");

/** Portable public-operation marker. Cloudflare's emitted class also uses its
 * client-facing `@callable()` decorator; internal child calls remain native DO
 * RPC behind the compiler's explicit boundary ACL. No hierarchy is implied. */
type CallableDecorator = {
  <This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
  ): (this: This, ...args: Args) => Return;
  (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): void;
};

export function callable(metadata: CallableMetadata = {}): CallableDecorator {
  // TypeScript type-checks the Stage 3 form. Bun currently lowers decorators
  // through the legacy three-argument helper, so accept both at runtime while
  // recording the actual method function in either case.
  return ((target: AnyMethod | object, context: unknown, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      if (typeof descriptor.value !== "function") {
        throw new TypeError(`callable() can only decorate methods (${String(context)})`);
      }
      callableMethods.set(descriptor.value as AnyMethod, metadata);
      return;
    }
    if (typeof target !== "function") {
      throw new TypeError("callable() can only decorate methods");
    }
    callableMethods.set(target as AnyMethod, metadata);
    return target as AnyMethod;
  }) as CallableDecorator;
}

export type CallableRef<F extends AnyMethod> = F & {
  readonly [CALLABLE_REF]: AgentCapabilityDeclaration<F>;
};

export function callableMetadata(method: AnyMethod): CallableMetadata | undefined {
  return callableMethods.get(method);
}

export function bindCallable<F extends AnyMethod>(
  method: F,
  thisArg: unknown,
  metadata: CallableMetadata = {},
): CallableRef<F> {
  const bound = method.bind(thisArg) as F;
  Object.defineProperty(bound, CALLABLE_REF, {
    value: { kind: metadata.kind ?? "method" },
    enumerable: false,
  });
  return bound as CallableRef<F>;
}

/** Mark an explicitly passed callable as the sink for a delegated child result. */
export function result<F extends AnyMethod>(method: F): CallableRef<F> {
  const wrapped = ((...args: Parameters<F>) => method(...args)) as F;
  Object.defineProperty(wrapped, CALLABLE_REF, {
    value: { kind: "result" },
    enumerable: false,
  });
  return wrapped as CallableRef<F>;
}

export function callableRefDeclaration(
  value: unknown,
): AgentCapabilityDeclaration | undefined {
  if (typeof value !== "function") return undefined;
  return (value as AnyMethod & {
    [CALLABLE_REF]?: AgentCapabilityDeclaration;
  })[CALLABLE_REF];
}
