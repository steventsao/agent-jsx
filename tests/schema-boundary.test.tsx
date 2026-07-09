/**
 * SCHEMA-DRIVEN BOUNDARIES — the contract under test:
 *
 *   - a boundary VALIDATES the child's serializable input against `inputSchema`
 *     (the props that cross as setProps; callbacks excluded) — a mismatch throws
 *     LOUDLY, naming the boundary;
 *   - a boundary VALIDATES a continuation output against `outputSchema` before it
 *     is written to the parent's reserved __outputs slot — same loud throw;
 *   - `description`/`displayName`/the schemas are EMBEDDED in the generated
 *     artifacts (the cloudflare class doc + the flue profile `description`), so
 *     the contract is visible in fixtures, not just enforced at runtime.
 *
 * zod is the schema here (any `{ parse }` works); the runtime file set imports
 * no zod — validation is duck-typed, so compiled artifacts stay self-contained.
 */

import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { agentComponent } from "../src/agent-component.tsx";
import { createStore, withOutputs } from "../src/store.ts";
import { collectInfra } from "../src/tree.ts";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { discoverAgents } from "../src/compile/graph.ts";
import { emitCloudflare } from "../src/compile/emit-cloudflare.ts";
import { emitFlueChild } from "../src/compile/emit-flue.ts";
import { Worker } from "../examples/tool-slot/worker.tsx";

/** Render a Worker boundary (the wrapper runs, so validation runs) → its records. */
const renderWorker = (
  props: Record<string, unknown>,
  ctx: { outputs: Record<string, unknown>; setOutput: (name: string, output: unknown) => void } = {
    outputs: {},
    setOutput: () => {},
  }
) =>
  withOutputs(ctx, () =>
    evaluateTree({
      type: Worker,
      props: { name: "w:main", onResult: () => {}, ...props },
    } as never)
  ).flatMap((r) => collectInfra(r));

describe("schema-driven boundaries — input validation (setProps)", () => {
  it("accepts serializable input that matches inputSchema", () => {
    const records = renderWorker({ query: "who filed the 10-K?" });
    const rec = records.find((r) => r.name === "w:main");
    expect(rec?.kind).toBe("subagent");
    expect(rec?.config).toMatchObject({ kind: "tool-worker", query: "who filed the 10-K?" });
  });

  it("throws loudly, naming the boundary, when input violates inputSchema", () => {
    // "" fails z.string().min(1)
    expect(() => renderWorker({ query: "" })).toThrow(
      /boundary "w:main" \(kind tool-worker\): input does not match inputSchema/
    );
  });

  it("validates only the serializable subset — callbacks are not schema data", () => {
    // onResult (a function) must not trip a non-strict object schema.
    expect(() => renderWorker({ query: "ok", onResult: () => {} })).not.toThrow();
  });
});

describe("schema-driven boundaries — output validation (emit → __outputs)", () => {
  const emitOf = (): { emit: (o: unknown) => void; captured: Record<string, unknown> } => {
    const captured: Record<string, unknown> = {};
    const records = renderWorker(
      { query: "q", children: (_o: unknown) => null },
      { outputs: {}, setOutput: (n: string, o: unknown) => { captured[n] = o; } }
    );
    const rec = records.find((r) => r.name === "w:main");
    return { emit: rec!.handlers.__emit as (o: unknown) => void, captured };
  };

  it("writes an emitted output that matches outputSchema", () => {
    const { emit, captured } = emitOf();
    emit({ answer: "42" });
    expect(captured["w:main"]).toEqual({ answer: "42" });
  });

  it("throws loudly, naming the boundary, when the emitted output violates outputSchema", () => {
    const { emit } = emitOf();
    expect(() => emit({ wrong: 1 })).toThrow(
      /boundary "w:main" \(kind tool-worker\): output does not match outputSchema/
    );
  });
});

describe("schema-driven boundaries — the contract is embedded in generated artifacts", () => {
  // A minimal root that composes the schema'd worker as a normal child.
  const Root = agentComponent<Record<string, unknown>, { done: boolean }>({
    agentName: "schema-root",
    initialState: { done: false },
    impl: ({ store: _store }) => (
      <>
        <Worker name="research" query="quarterly revenue" onResult={() => {}} />
        <prompt>
          <sys p={10}>Delegate research to the worker.</sys>
        </prompt>
      </>
    ),
  });

  it("the cloudflare module carries the child's description, displayName, and schema references", () => {
    const graph = discoverAgents(
      { spec: Root.spec, exportName: "Root", importPath: "./root.tsx" },
      [{ spec: Worker.spec, exportName: "Worker", importPath: "./worker.tsx" }]
    );
    const cf = emitCloudflare(
      { spec: graph[0]!.spec, componentName: "Root", componentImport: "./root.tsx" },
      graph.slice(1).map((n) => ({ spec: n.spec, exportName: n.exportName, importPath: n.importPath })),
      graph[0]!.analysis,
      { runtimeImport: "./runtime" }
    ).agents;

    expect(cf).toContain("Answer a research query from the document corpus.");
    expect(cf).toContain("@displayName Researcher");
    expect(cf).toContain(
      "@boundarySchema input=Worker.spec.inputSchema output=Worker.spec.outputSchema (validated at the boundary)"
    );
  });

  it("the flue child profile carries the description", () => {
    const flueChild = emitFlueChild(
      { spec: Worker.spec, exportName: "Worker", importPath: "./worker.tsx" },
      400,
      { runtimeImport: "./runtime" }
    );
    expect(flueChild).toContain('description: "Answer a research query from the document corpus.",');
  });
});
