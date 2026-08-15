/**
 * Compile target: flue 2.0 (function agents).
 *
 * Flue 2.0 replaced compile-once static profiles with FUNCTION agents the
 * session re-renders every turn: hooks (useModel/useTool/usePersistentState)
 * resolve against a per-render frame, resources may be declared
 * conditionally, and durable state writes become visible on the NEXT turn's
 * render. That is agent-jsx's own state→render loop, native — so this target
 * emits NO compile-time evaluation at all. The emitted module hands the
 * authored class to renderFlue2Agent, which binds state from
 * usePersistentState and declares whatever getPrompt()/getTools() produce
 * for THAT render. Prop/state changes re-render the harness dynamically.
 */
import { describe, expect, it } from "bun:test";
import { Agent, callable } from "../src/agent-class.tsx";
import { emitFlue2 } from "../src/compile/emit-flue2.ts";
import {
  renderFlue2Agent,
  type Flue2Hooks,
  type Flue2ToolDecl,
} from "../src/compile/flue2-runtime.ts";

interface OncallState extends Record<string, unknown> {
  incident: boolean;
  pageCount: number;
}

/** The uptime story, class form: the tool surface is derived state. */
class OncallAgent extends Agent<OncallState> {
  static agentName = "oncall";
  model = "test/oncall-model";
  description = "Watches sites and pages oncall during incidents.";
  initialState: OncallState = { incident: false, pageCount: 0 };

  getPrompt() {
    return (
      <prompt>
        <sys p={10}>Incident active: {String(this.state.incident)}</sys>
      </prompt>
    );
  }

  getTools(): Record<string, unknown> {
    const tools: Record<string, unknown> = {
      check_status: {
        description: "Poll the site status.",
        execute: async () => "ok",
      },
    };
    if (this.state.incident) {
      tools.page_oncall = {
        description: "Page the oncall engineer.",
        execute: async () => {
          this.setState({ ...this.state, pageCount: this.state.pageCount + 1 });
          return "paged";
        },
      };
    }
    return tools;
  }

  @callable()
  markIncident(active: boolean) {
    this.setState({ ...this.state, incident: active });
  }
}

interface RenderRecord {
  models: string[];
  tools: Flue2ToolDecl[];
}

/** Minimal flue-2.0 session semantics: per-render frame, durable state
 *  snapshots, writes visible on the NEXT render. */
function flue2Session(initialPersisted: unknown) {
  let persisted = initialPersisted;
  const renders: RenderRecord[] = [];
  const beginRender = () => {
    const snapshot = persisted;
    const record: RenderRecord = { models: [], tools: [] };
    const hooks: Flue2Hooks = {
      useModel: (model) => {
        record.models.push(model);
      },
      usePersistentState: (_name, defaultValue) => [
        snapshot === undefined ? defaultValue : (snapshot as never),
        (next) => {
          const base = snapshot === undefined ? defaultValue : snapshot;
          persisted =
            typeof next === "function" ? (next as (p: unknown) => unknown)(base) : next;
        },
      ],
      useTool: (tool) => {
        record.tools.push(tool);
      },
    };
    renders.push(record);
    return { hooks, record };
  };
  return {
    beginRender,
    renders,
    get persisted() {
      return persisted;
    },
  };
}

describe("renderFlue2Agent (flue 2.0 dynamic re-render)", () => {
  it("declares the authored model on every render", () => {
    const session = flue2Session(undefined);
    for (let i = 0; i < 3; i++) {
      const { hooks, record } = session.beginRender();
      renderFlue2Agent(OncallAgent, hooks);
      expect(record.models).toEqual(["test/oncall-model"]);
    }
    expect(session.renders).toHaveLength(3);
  });

  it("instruction tracks durable state across renders", () => {
    const session = flue2Session(undefined);
    const rest1 = renderFlue2Agent(OncallAgent, session.beginRender().hooks);
    expect(rest1).toContain("Incident active: false");

    // Simulate an out-of-band write landing in the instance record log.
    const withIncident = { incident: true, pageCount: 0 };
    const session2 = flue2Session(withIncident);
    const rest2 = renderFlue2Agent(OncallAgent, session2.beginRender().hooks);
    expect(rest2).toContain("Incident active: true");
  });

  it("tool surface is derived state: page_oncall exists only during an incident", () => {
    const calm = flue2Session({ incident: false, pageCount: 0 });
    renderFlue2Agent(OncallAgent, calm.beginRender().hooks);
    expect(calm.renders[0]!.tools.map((t) => t.name)).toEqual(["check_status"]);

    const incident = flue2Session({ incident: true, pageCount: 0 });
    renderFlue2Agent(OncallAgent, incident.beginRender().hooks);
    expect(incident.renders[0]!.tools.map((t) => t.name)).toEqual([
      "check_status",
      "page_oncall",
    ]);
  });

  it("tool runs persist state for the NEXT render", async () => {
    const session = flue2Session({ incident: true, pageCount: 0 });
    const first = session.beginRender();
    renderFlue2Agent(OncallAgent, first.hooks);
    const page = first.record.tools.find((t) => t.name === "page_oncall")!;
    expect(await page.run({})).toBe("paged");

    // The write is durable; the next turn's render reads it.
    const second = session.beginRender();
    renderFlue2Agent(OncallAgent, second.hooks);
    expect(session.persisted).toMatchObject({ pageCount: 1 });
  });
});

describe("emitFlue2 (module shape)", () => {
  const spec = { agentName: "oncall" } as never;
  const source = emitFlue2({
    spec,
    sourceImport: "../oncall.agent.tsx",
    exportName: "OncallAgent",
  });

  it("carries the 'use agent' directive and a default-exported function", () => {
    expect(source).toContain("'use agent'");
    expect(source).toMatch(/export default function Oncall\(/);
  });

  it("imports the flue 2.0 hooks and the authored definition", () => {
    expect(source).toContain(
      `import { useModel, usePersistentState, useTool } from "@flue/runtime";`
    );
    expect(source).toContain(`import OncallAgent from "../oncall.agent.tsx";`);
  });

  it("delegates each render to the runtime — no compile-time evaluation", () => {
    expect(source).toContain("renderFlue2Agent(OncallAgent, {");
    // The static-target smells must be absent: no resting instructions, no
    // profile literal, no spawn plan.
    expect(source).not.toContain("defineAgentProfile");
    expect(source).not.toContain("spawnPlan");
    expect(source).not.toContain("Incident active");
  });

  it("honors a custom runtime import base", () => {
    const custom = emitFlue2({
      spec,
      sourceImport: "../oncall.agent.tsx",
      exportName: "OncallAgent",
      runtimeImport: "./runtime",
    });
    expect(custom).toContain(`from "./runtime/flue2-runtime.ts"`);
  });
});
