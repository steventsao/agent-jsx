import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type StoreModule = typeof import("../src/store.ts");
type StateModule = typeof import("../src/state.ts");

async function bundleEntry<M>(source: URL, outdir: string): Promise<M> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(source)],
    outdir,
    target: "node",
    format: "esm",
  });
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  return import(pathToFileURL(result.outputs[0]!.path).href) as Promise<M>;
}

describe("withStaticEval", () => {
  it("keeps an outer scope active across a nested scope and exceptions", async () => {
    const store = await import("../src/store.ts");

    expect(store.isStaticEval()).toBe(false);
    expect(() =>
      store.withStaticEval(() => {
        expect(store.isStaticEval()).toBe(true);
        expect(() =>
          store.withStaticEval(() => {
            expect(store.isStaticEval()).toBe(true);
            throw new Error("nested");
          }),
        ).toThrow("nested");
        expect(store.isStaticEval()).toBe(true);
      }),
    ).not.toThrow();
    expect(store.isStaticEval()).toBe(false);
  });

  it("shares the scope across independently bundled entrypoints", async () => {
    const temp = await mkdtemp(join(tmpdir(), "agent-jsx-static-eval-"));
    try {
      const compiler = await bundleEntry<StoreModule>(
        new URL("../src/store.ts", import.meta.url),
        join(temp, "compiler"),
      );
      const state = await bundleEntry<StateModule>(
        new URL("../src/state.ts", import.meta.url),
        join(temp, "state"),
      );
      const store = state.createStore({ count: 1 });

      expect(compiler.isStaticEval()).toBe(false);
      compiler.withStaticEval(() => {
        // This is the package boundary that matters: an evaluator bundle owns
        // the scope while the separately bundled public state entrypoint avoids
        // React's dispatcher and performs a plain durable-store read.
        expect(state.useAgentState(store)).toEqual({ count: 1 });
        state.withStaticEval(() => {
          expect(compiler.isStaticEval()).toBe(true);
          expect(state.useAgentState(store)).toEqual({ count: 1 });
        });
        expect(compiler.isStaticEval()).toBe(true);
        expect(state.useAgentState(store)).toEqual({ count: 1 });
      });
      expect(compiler.isStaticEval()).toBe(false);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
