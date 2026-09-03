import { describe, expect, it } from "bun:test";

import {
  AsyncAgentFunctionError,
  CyclicGeneratedDependencyError,
  MissingGeneratedDependencyError,
  defineGeneratedAgent,
  makeGeneratedAgentRuntime,
  type GeneratedAgentDefinition,
  type MissingGeneratedDependencies,
} from "../src/generated-runtime.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

function compileTimeContracts() {
  // @ts-expect-error generated descriptors reject Promise-returning agent functions
  defineGeneratedAgent({
    name: "async-is-not-an-agent",
    requires: [] as const,
    render: async () => null,
  });

  const missing = defineGeneratedAgent({
    name: "open-graph",
    requires: ["not-provided"] as const,
    render: () => null,
  });
  // @ts-expect-error generated tuples must provide every required agent name
  void makeGeneratedAgentRuntime([missing] as const);
}
void compileTimeContracts;

describe("compiler-owned generated runtime", () => {
  it("retains literal provides/requires information for compiler diagnostics", () => {
    const openGraph = [
      defineGeneratedAgent({
        name: "reviewer",
        requires: ["database", "model"] as const,
        render: () => null,
      }),
      defineGeneratedAgent({
        name: "database",
        requires: [] as const,
        render: () => null,
      }),
    ] as const;

    const missingIsModel: Equal<MissingGeneratedDependencies<typeof openGraph>, "model"> = true;
    expect(missingIsModel).toBe(true);
  });

  it("builds resources once, renders synchronously, and finalizes once", async () => {
    const events: string[] = [];
    const database = defineGeneratedAgent({
      name: "database",
      requires: [] as const,
      acquire: () => {
        events.push("acquire:database");
        return { dsn: "memory://agent-jsx" };
      },
      release: () => {
        events.push("release:database");
      },
      render: (_props: {}, { resource }) => resource.dsn,
    });
    const reviewer = defineGeneratedAgent({
      name: "reviewer",
      requires: ["database"] as const,
      acquire: (dependencies) => {
        events.push("acquire:reviewer");
        return { database: dependencies.database as { dsn: string } };
      },
      release: () => {
        events.push("release:reviewer");
      },
      render: (props: { document: string }, { resource }) =>
        `${props.document}@${resource.database.dsn}`,
    });

    const runtime = await makeGeneratedAgentRuntime([database, reviewer] as const);
    expect(events.filter((event) => event.startsWith("acquire:"))).toEqual([
      "acquire:database",
      "acquire:reviewer",
    ]);
    expect(runtime.render("reviewer", { document: "proposal" })).toBe(
      "proposal@memory://agent-jsx",
    );
    expect(runtime.render("reviewer", { document: "contract" })).toBe(
      "contract@memory://agent-jsx",
    );
    expect(runtime.resource("database")).toEqual({ dsn: "memory://agent-jsx" });
    expect(events.filter((event) => event.startsWith("acquire:"))).toHaveLength(2);

    await runtime.dispose();
    await runtime.dispose();
    expect(events.filter((event) => event.startsWith("release:"))).toHaveLength(2);
  });

  it("rejects missing and cyclic generated graphs before acquiring resources", async () => {
    const missing = defineGeneratedAgent({
      name: "reviewer",
      requires: ["database"] as const,
      render: () => null,
    });
    await expect(
      makeGeneratedAgentRuntime([missing] as any),
    ).rejects.toBeInstanceOf(MissingGeneratedDependencyError);

    const a = defineGeneratedAgent({
      name: "a",
      requires: ["b"] as const,
      render: () => null,
    });
    const b = defineGeneratedAgent({
      name: "b",
      requires: ["a"] as const,
      render: () => null,
    });
    await expect(makeGeneratedAgentRuntime([a, b] as const)).rejects.toBeInstanceOf(
      CyclicGeneratedDependencyError,
    );
  });

  it("rejects a Promise from an authored agent function at the runtime boundary", async () => {
    // A generated JS file or an `any` escape can bypass the TypeScript guard;
    // the runtime assertion is the second line of defense.
    const invalid = {
      name: "invalid",
      requires: [] as const,
      render: async () => "not allowed",
    } as unknown as GeneratedAgentDefinition<"invalid", readonly [], undefined, {}, string>;
    const runtime = await makeGeneratedAgentRuntime([invalid] as const);
    try {
      expect(() => runtime.render("invalid", {})).toThrow(AsyncAgentFunctionError);
    } finally {
      await runtime.dispose();
    }
  });
});
