/**
 * Capability-level schema validation — `inputSchema`/`outputSchema` on an
 * individual capability declaration (src/agent-component.tsx:407-423 and the
 * sync/async return paths at :519-544).
 *
 * The boundary wraps every granted function prop in a validating closure:
 * arguments are checked (as the parameter tuple) BEFORE the authored callback
 * runs; the return value is checked AFTER — synchronously for sync returns,
 * on the resolved value for thenables. Violations throw (or reject) loudly,
 * naming the boundary, the capability, and the phase. Schemas live only in
 * the closure: they never leak into `bindings` metadata or `config`.
 */

import { describe, expect, it } from "bun:test";
import {
  agentComponent,
  type BoundarySchema,
} from "../src/agent-component.tsx";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { collectInfra } from "../src/tree.ts";
import type { InfraRecord } from "../src/types.ts";

const queryArgs: BoundarySchema<[string, number]> = {
  parse(value) {
    if (
      !Array.isArray(value) ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "number"
    ) {
      throw new Error("expected [string, number]");
    }
    return value as [string, number];
  },
};

const queryOut: BoundarySchema<string> = {
  parse(value) {
    if (typeof value !== "string") throw new Error("expected string return");
    return value;
  },
};

interface SearchProps {
  label: string;
  query: (text: string, limit: number) => string;
}

const Searcher = agentComponent<SearchProps, Record<string, never>>({
  agentName: "searcher",
  initialState: {},
  capabilities: {
    query: { kind: "method", inputSchema: queryArgs, outputSchema: queryOut },
  },
  impl: () => null,
});

interface LookupProps {
  lookup: (id: string) => Promise<{ id: string }>;
}

const lookupArgs: BoundarySchema<[string]> = {
  parse(value) {
    if (!Array.isArray(value) || typeof value[0] !== "string") {
      throw new Error("expected [string]");
    }
    return value as [string];
  },
};

const lookupOut: BoundarySchema<{ id: string }> = {
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { id?: unknown }).id !== "string"
    ) {
      throw new Error("expected { id: string }");
    }
    return value as { id: string };
  },
};

const Lookup = agentComponent<LookupProps, Record<string, never>>({
  agentName: "lookup",
  initialState: {},
  capabilities: {
    lookup: { kind: "method", inputSchema: lookupArgs, outputSchema: lookupOut },
  },
  impl: () => null,
});

/** Evaluate the boundary and return its routed (validating) subagent record. */
const routedRecord = (element: unknown): InfraRecord => {
  const record = evaluateTree(element)
    .flatMap((root) => collectInfra(root))
    .find((r) => r.kind === "subagent");
  if (!record) throw new Error("no subagent record");
  return record;
};

describe("capability schemas — sync return path", () => {
  it("passes valid arguments and return values straight through", () => {
    const seen: unknown[][] = [];
    const record = routedRecord(
      <Searcher
        name="s:1"
        label="main"
        query={(text, limit) => {
          seen.push([text, limit]);
          return `hit:${text}`;
        }}
      />
    );

    expect(record.handlers.query?.("dns", 3)).toBe("hit:dns");
    expect(seen).toEqual([["dns", 3]]);
    // Schemas never leak into the serialized record surface.
    expect(record.bindings).toEqual({ query: { kind: "method" } });
    expect(record.config).toEqual({ kind: "searcher", label: "main" });
  });

  it("rejects invalid arguments BEFORE the authored callback runs", () => {
    const seen: unknown[][] = [];
    const record = routedRecord(
      <Searcher
        name="s:1"
        label="main"
        query={(text, limit) => {
          seen.push([text, limit]);
          return "hit";
        }}
      />
    );

    expect(() => record.handlers.query?.(42, 3)).toThrow(
      '[agent-jsx] boundary "s:1" (kind searcher): capability "query" arguments failed schema — expected [string, number]'
    );
    expect(seen).toEqual([]);
  });

  it("rejects an invalid synchronous return value", () => {
    const record = routedRecord(
      <Searcher name="s:1" label="main" query={() => 42 as never} />
    );

    expect(() => record.handlers.query?.("dns", 3)).toThrow(
      '[agent-jsx] boundary "s:1" (kind searcher): capability "query" return failed schema — expected string return'
    );
  });
});

describe("capability schemas — async return path", () => {
  it("validates the RESOLVED value of a thenable return", async () => {
    const record = routedRecord(
      <Lookup name="l:1" lookup={async (id) => ({ id })} />
    );

    await expect(record.handlers.lookup?.("x")).resolves.toEqual({ id: "x" });
  });

  it("rejects asynchronously when the resolved value mismatches", async () => {
    const record = routedRecord(
      <Lookup name="l:1" lookup={async () => 42 as never} />
    );

    await expect(record.handlers.lookup?.("x")).rejects.toThrow(
      '[agent-jsx] boundary "l:1" (kind lookup): capability "lookup" return failed schema — expected { id: string }'
    );
  });

  it("argument validation is synchronous even on an async capability", () => {
    const record = routedRecord(
      <Lookup name="l:1" lookup={async (id) => ({ id })} />
    );

    expect(() => record.handlers.lookup?.(7)).toThrow(
      '[agent-jsx] boundary "l:1" (kind lookup): capability "lookup" arguments failed schema — expected [string]'
    );
  });
});

describe("capability schemas — opt-in", () => {
  it("a capability without schemas passes any value through unvalidated", () => {
    interface PingProps {
      ping: (a: number, b: boolean) => number;
    }
    const Pinger = agentComponent<PingProps, Record<string, never>>({
      agentName: "pinger",
      initialState: {},
      capabilities: { ping: { kind: "callback" } },
      impl: () => null,
    });
    const seen: unknown[][] = [];
    const record = routedRecord(
      <Pinger
        name="p:1"
        ping={(a, b) => {
          seen.push([a, b]);
          return a;
        }}
      />
    );

    expect(record.handlers.ping?.("not-a-number" as never, 0 as never)).toBe(
      "not-a-number"
    );
    expect(seen).toEqual([["not-a-number", 0]]);
  });
});
