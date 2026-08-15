/**
 * The react-free runtime behind the flue 2.0 function-agent target.
 *
 * Flue 2.0 re-renders the agent function every turn: hooks resolve against a
 * per-render frame, resources (tools/skills/subagents) may be declared
 * conditionally, and durable `usePersistentState` writes become visible on
 * the NEXT turn's render. That is agent-jsx's state→render loop as a native
 * target primitive, so this module performs NO compile-time evaluation — each
 * flue render binds the authored class to a store seeded from the current
 * durable snapshot and declares whatever getPrompt()/getTools() produce for
 * THAT state. The model's tool surface and instruction are derived state,
 * re-rendered dynamically per prop/state change.
 *
 * Root-agent contract of this slice: props are `{}` (a deployed root receives
 * task input as messages, not props); durable agent state round-trips through
 * one persistent-state record keyed `__agentjsx_state`.
 */

import { compileAgentClass, type AgentDefinition } from "../agent-class.tsx";
import { createStore } from "../store.ts";
import { collectInfra, collectPrompt } from "../tree.ts";
import { renderPromptOrFallback } from "../prompt.ts";
import { evaluateComponent } from "./evaluate.ts";

/** The tool shape a flue 2.0 `useTool` accepts, structurally narrowed to what
 *  this slice needs: input schemas ride along in a later slice, so `run`
 *  receives the flue tool context and forwards its (absent) data payload. */
export interface Flue2ToolDecl {
  name: string;
  description: string;
  run: (context: unknown) => string | Promise<string>;
}

/** The flue 2.0 hook surface the emitted module forwards, structurally typed
 *  so tests can drive renders with a recording session harness. */
export interface Flue2Hooks {
  useModel(model: string): void;
  usePersistentState<T>(
    name: string,
    defaultValue: T,
  ): [T, (next: T | ((prev: T) => T)) => void];
  useTool(tool: Flue2ToolDecl): void;
}

export interface Flue2RenderOptions {
  /** Token budget for the declarative <prompt> tree (chars/4, priompt-lite). */
  promptBudget?: number;
}

/** Durable record key for the agent's whole state object. One key keeps the
 *  record log compact and the (de)serialization a single JSON round-trip. */
const STATE_KEY = "__agentjsx_state";
const DEFAULT_PROMPT_BUDGET = 400;

/** compileAgentClass validation + spec assembly once per definition, not per
 *  render — the spec is static; only its EVALUATION is per-turn. */
const compiledCache = new WeakMap<
  AgentDefinition<any>,
  ReturnType<typeof compileAgentClass>
>();

function specFor(definition: AgentDefinition<any>) {
  let compiled = compiledCache.get(definition);
  if (!compiled) {
    compiled = compileAgentClass(definition);
    compiledCache.set(definition, compiled);
  }
  return compiled.spec;
}

/**
 * Run one flue 2.0 render of an authored agent-jsx class. Declare the model,
 * seed a store from the durable snapshot, evaluate the class's prompt/tool
 * seams against it, declare the resulting tools, and return the instruction
 * string. Tool `run` wrappers persist the store afterwards, so a state
 * mutation becomes visible to the NEXT render — the dynamic loop.
 */
export function renderFlue2Agent<C extends AgentDefinition<any>>(
  Definition: C,
  hooks: Flue2Hooks,
  options: Flue2RenderOptions = {},
): string {
  const spec = specFor(Definition);
  const [state, setState] = hooks.usePersistentState(STATE_KEY, spec.initialState);
  hooks.useModel(spec.model as string);

  const store = createStore(state);
  const roots = evaluateComponent(spec.impl, { store } as never);

  const instruction = renderPromptOrFallback(
    collectPrompt(roots),
    options.promptBudget ?? DEFAULT_PROMPT_BUDGET,
    () => "",
  );

  for (const record of roots.flatMap((root) => collectInfra(root))) {
    if (record.kind !== "tool") continue;
    const run = record.handlers.run;
    if (typeof run !== "function") continue;
    hooks.useTool({
      name: record.name,
      description: String(record.config.description ?? ""),
      run: async (context) => {
        const data = (context as { data?: Record<string, unknown> } | undefined)?.data ?? {};
        const output = await run(data);
        setState(store.get());
        return output as string;
      },
    });
  }

  return instruction;
}
