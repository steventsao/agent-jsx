/**
 * Boundary ERROR PATHS — the runtime half of the capability contract. The
 * type-level exhaustiveness of `capabilities` is locked by
 * tests/agent-contracts.type-test.tsx; here the specs are cast past the
 * compiler on purpose to prove the boundary still rejects violations at
 * render time, loudly, naming the boundary.
 *
 * Contract locations:
 *   - src/agent-component.tsx — undeclared function prop, multiple result
 *     capabilities;
 *   - src/tree.ts — collectInfra identity check, resultBindingName.
 */

import { describe, expect, it } from "bun:test";
import {
  agentComponent,
  type AgentCapabilities,
} from "../src/agent-component.tsx";
import { evaluateTree } from "../src/compile/evaluate.ts";
import { collectInfra, resultBindingName } from "../src/tree.ts";
import type { InfraRecord } from "../src/types.ts";

interface LeakyProps {
  label: string;
  onLeak: (value: string) => void;
}

/** `capabilities: {}` is a type error for a props type with function members
 *  (the exhaustiveness contract). Casting past it simulates a hand-written or
 *  stale spec — the boundary must STILL refuse the implicit grant at runtime. */
const Leaky = agentComponent<LeakyProps, Record<string, never>>({
  agentName: "leaky-child",
  initialState: {},
  capabilities: {} as AgentCapabilities<LeakyProps>,
  impl: () => null,
});

interface MultiResultProps {
  onDone: (value: string) => void;
  onFinish: (value: string) => void;
}

const MultiResult = agentComponent<MultiResultProps, Record<string, never>>({
  agentName: "multi-result",
  initialState: {},
  capabilities: {
    onDone: { kind: "result" },
    onFinish: { kind: "result" },
  },
  impl: () => null,
});

describe("boundary errors — capability ACL", () => {
  it("rejects a function-valued prop with no capability declaration at render time", () => {
    expect(() =>
      evaluateTree(<Leaky name="leak:1" label="alpha" onLeak={() => {}} />)
    ).toThrow(
      '[agent-jsx] boundary "leak:1" (kind leaky-child): function prop "onLeak" has no explicit capability declaration'
    );
  });

  it("rejects a boundary declaring more than one result capability", () => {
    expect(() =>
      evaluateTree(
        <MultiResult name="mr:1" onDone={() => {}} onFinish={() => {}} />
      )
    ).toThrow(
      '[agent-jsx] boundary "mr:1" (kind multi-result): multiple result capabilities (onDone, onFinish)'
    );
  });

  it("accepts a single result capability (control: no spurious rejection)", () => {
    const roots = evaluateTree(
      <MultiResult name="mr:2" onDone={() => {}} onFinish={undefined as never} />
    );
    const record = roots.flatMap((root) => collectInfra(root))[0];
    expect(record?.bindings).toEqual({ onDone: { kind: "result" } });
  });
});

describe("boundary errors — collectInfra identity", () => {
  it("rejects an infra intrinsic without a string `name`", () => {
    expect(() =>
      collectInfra({ type: "subagent", props: { kind: "worker" }, children: [] })
    ).toThrow("<subagent> requires a stable string `name` prop (host-level identity)");
    expect(() =>
      collectInfra({ type: "task", props: { name: 42 }, children: [] })
    ).toThrow("<task> requires a stable string `name` prop (host-level identity)");
  });

  it("rejects an empty-string `name`", () => {
    expect(() =>
      collectInfra({ type: "sensor", props: { name: "" }, children: [] })
    ).toThrow("<sensor> requires a stable string `name` prop (host-level identity)");
  });
});

describe("boundary errors — resultBindingName", () => {
  it("throws when a record declares multiple result bindings", () => {
    const record: InfraRecord = {
      kind: "subagent",
      name: "w",
      config: {},
      handlers: {},
      bindings: {
        first: { kind: "result" },
        second: { kind: "result" },
      },
    };
    expect(() => resultBindingName(record)).toThrow(
      '[agent-jsx] subagent "w" declares multiple result bindings (first, second)'
    );
  });
});
