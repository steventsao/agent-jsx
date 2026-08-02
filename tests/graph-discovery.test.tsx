/**
 * discoverAgents — the unresolved-kind skip (graph.ts:148-164).
 *
 * A parent whose render records a `<subagent kind=... />` boundary whose kind
 * is missing from the registry is SKIPPED SILENTLY: no throw, no node for
 * that child. The boundary still shows up in the root's `directChildren` (the
 * kinds its OWN render can spawn), but discovery only enqueues kinds the
 * caller actually registered — "the caller composed a boundary whose component
 * it did not register". The transitive happy path lives in nesting.test.tsx.
 */

import { describe, expect, it } from "bun:test";
import { agentComponent } from "../src/agent-component.tsx";
import { discoverAgents } from "../src/compile/graph.ts";

const GhostChild = agentComponent({
  agentName: "ghost-child",
  initialState: {},
  impl: () => (
    <prompt>
      <sys p={10}>Never registered with discovery.</sys>
    </prompt>
  ),
});

const KnownChild = agentComponent({
  agentName: "known-child",
  initialState: {},
  impl: () => (
    <prompt>
      <sys p={10}>Registered with discovery.</sys>
    </prompt>
  ),
});

const Root = agentComponent({
  agentName: "discovery-root",
  initialState: {},
  impl: () => (
    <>
      <GhostChild name="ghost:main" />
      <KnownChild name="known:main" />
      <prompt>
        <sys p={10}>Nests one known and one unregistered child.</sys>
      </prompt>
    </>
  ),
});

const rootModule = { spec: Root.spec, exportName: "Root", importPath: "./root.tsx" };
const knownModule = { spec: KnownChild.spec, exportName: "KnownChild", importPath: "./known-child.tsx" };

describe("discoverAgents — unresolved child kinds are skipped, not fatal", () => {
  it("a root whose ONLY boundary is unregistered yields just the root", () => {
    const LoneRoot = agentComponent({
      agentName: "lone-root",
      initialState: {},
      impl: () => (
        <>
          <GhostChild name="ghost:main" />
          <prompt>
            <sys p={10}>Nests only an unregistered child.</sys>
          </prompt>
        </>
      ),
    });
    const graph = discoverAgents(
      { spec: LoneRoot.spec, exportName: "LoneRoot", importPath: "./lone-root.tsx" },
      [] // ghost-child is composed but never registered
    );
    expect(graph.map((n) => n.spec.agentName)).toEqual(["lone-root"]);
    expect(graph[0]!.isRoot).toBe(true);
    // The boundary was SEEN — it is recorded as a direct child kind…
    expect(graph[0]!.directChildren).toEqual(["ghost-child"]);
    // …but no node was emitted for it.
    expect(graph.some((n) => n.spec.agentName === "ghost-child")).toBe(false);
  });

  it("a mixed composition discovers the registered child and skips the rest", () => {
    const graph = discoverAgents(rootModule, [knownModule]);
    expect(graph.map((n) => n.spec.agentName)).toEqual(["discovery-root", "known-child"]);
    expect(graph[0]!.directChildren).toEqual(["ghost-child", "known-child"]);
    expect(graph[1]!.isRoot).toBe(false);
  });

  it("registering the child discovers it (the skip is registry-driven)", () => {
    const graph = discoverAgents(rootModule, [
      knownModule,
      { spec: GhostChild.spec, exportName: "GhostChild", importPath: "./ghost-child.tsx" },
    ]);
    expect(graph.map((n) => n.spec.agentName)).toEqual(["discovery-root", "ghost-child", "known-child"]);
  });
});
