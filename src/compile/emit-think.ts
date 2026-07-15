/**
 * Compile target #1b: cloudflare/agents — THINK mode (model-driven delegation).
 *
 * The reconcile emitter (emit-cloudflare.ts) generates deterministic
 * `FiberAgentBase` classes: render → diff → apply, the runtime drives the work.
 * THINK mode generates `class X extends @cloudflare/think Think<Env>` instead:
 *
 *   - getSystemPrompt() = the component's <prompt> rendered over this.state (the
 *     context window), re-derived each model turn;
 *   - getTools() = the component's static <tool> records (→ an AI-SDK `tool`)
 *     PLUS every child boundary as `agentTool(ChildDurable, { description,
 *     inputSchema })`. A slot-bound child is NAMED BY THE PROP KEY; a plainly
 *     nested child is NAMED BY ITS KIND. The MODEL decides what to call;
 *   - one Think subclass per agent (a child is spawned per tool-call as a
 *     ctx.exports facet — the 0.17 agentTool semantics, see
 *     docs/agent-tools-investigation.md + docs/think-target.md).
 *
 * getModel() is emitted when the authored spec carries an explicit model. Older
 * low-level specs without one inherit Think's throwing default and can still be
 * overridden by a consumer or test. Pinned to agents@0.17.3 +
 * @cloudflare/think@0.12.1; the
 * generated runTurnWithTrace bridge retains Think's public text/reasoning
 * stream while binding the latest composition props for that turn. The proven
 * 0.8.x reconcile runtime is untouched. <sensor>/<schedule>/<task> have
 * no think-mode mapping (reconcile's job) → loud target diagnostics.
 */

import type { AnyAgentSpec } from "../agent-component.tsx";
import type { Analysis } from "./analyze.ts";
import type { ToolSlotBinding } from "./slots.ts";
import type { RootAgentSpec, ChildAgentSpec } from "./emit-cloudflare.ts";
import { emitRuntimeFiles } from "./runtime-files.ts";
import { evaluateComponent } from "./evaluate.ts";
import { collectInfra } from "../tree.ts";
import { createStore, withOutputs } from "../store.ts";
import {
  thinkTargetDiagnostics,
  formatTargetDiagnosticsForComment,
  type TargetDiagnostic,
} from "./target-diagnostics.ts";

export interface ThinkEmitOptions {
  /** Rewrites the generated runtime imports off `../../src` (e.g. "./runtime"). */
  runtimeImport?: string;
  /** Absolute fs path; when set, the react-free runtime file set is copied here. */
  emitRuntimeTo?: string;
  /** Priompt token budget for getSystemPrompt. Default 400. */
  promptBudget?: number;
  /** Tool-slot bindings (src/compile/slots.ts): a binding whose provider is a
   *  generated agent becomes a getTools() agentTool NAMED BY THE PROP KEY. */
  toolSlots?: ToolSlotBinding[];
  /** Optional deployment-owned adapter for explicit authored model ids. This
   *  keeps provider credentials/packages out of agent source while avoiding
   *  provider inference in the compiler. The export receives (env, modelId)
   *  and returns either the id or an AI SDK LanguageModel. */
  modelResolver?: {
    importPath: string;
    exportName: string;
  };
}

export interface ThinkEmit {
  agents: string;
  wrangler: string;
}

const pascal = (s: string) => s.replace(/(?:^|[-_:])(\w)/g, (_, c) => c.toUpperCase());
const scream = (s: string) => s.replace(/[-:]/g, "_").toUpperCase();
/** A child KIND → a valid AI-SDK tool name (identifier-ish). */
const toolIdent = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
/** Emit an object key unquoted when it is a valid identifier, else quoted. */
const identKey = (s: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : JSON.stringify(s));

/** Evaluate a spec's OWN render at sampleProps + initialState (expansion ON so a
 *  continuation-gated boundary/tool is still seen), collecting one kind of infra. */
function renderInfra(spec: AnyAgentSpec, sampleProps?: Record<string, unknown>) {
  const roots = withOutputs({ outputs: {}, setOutput: () => {}, expandSamples: true }, () =>
    evaluateComponent(spec.impl, {
      ...(sampleProps ?? spec.sampleProps ?? {}),
      store: createStore(spec.initialState),
      emit: () => {},
    } as never)
  );
  return roots.flatMap((root) => collectInfra(root));
}

/** Distinct subagent kinds a component's OWN render reveals, first-seen order. */
function childKindsOfSpec(child: ChildAgentSpec): string[] {
  const kinds: string[] = [];
  for (const rec of renderInfra(child.spec, child.sampleProps))
    if (rec.kind === "subagent") {
      const k = String(rec.config.kind);
      if (!kinds.includes(k)) kinds.push(k);
    }
  return kinds;
}

/** Distinct subagent kinds an analysis reveals — the root's direct children. */
function subagentKindsFromAnalysis(analysis: Analysis): string[] {
  const kinds: string[] = [];
  for (const r of [...analysis.static, ...analysis.dynamic])
    if (r.kind === "subagent") {
      const k = String(r.config.kind);
      if (!kinds.includes(k)) kinds.push(k);
    }
  return kinds;
}

/** Static <tool> records a component renders at rest: name + description. */
function staticToolsOfSpec(
  spec: AnyAgentSpec,
  sampleProps?: Record<string, unknown>,
): { name: string; description: string }[] {
  const tools: { name: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const rec of renderInfra(spec, sampleProps))
    if (rec.kind === "tool" && !seen.has(rec.name)) {
      seen.add(rec.name);
      tools.push({ name: rec.name, description: String(rec.config.description ?? "") });
    }
  return tools;
}

interface NodeInfo {
  isRoot: boolean;
  spec: AnyAgentSpec;
  exportName: string;
  importPath: string;
  className: string;
  binding: string;
  stateType: string;
  propsConst: string;
  sampleProps?: Record<string, unknown>;
  /** getTools agentTool entries: { toolName, childKind }. */
  entries: { toolName: string; childKind: string }[];
  tools: { name: string; description: string }[];
  diagnostics: TargetDiagnostic[];
}

export function emitThink(
  root: RootAgentSpec,
  children: ChildAgentSpec[],
  analysis: Analysis,
  opts: ThinkEmitOptions = {}
): ThinkEmit {
  const rt = opts.runtimeImport ?? "../../src";
  const budget = opts.promptBudget ?? 400;
  const slots = opts.toolSlots ?? [];

  const rootClass = `${pascal(root.spec.agentName)}Durable`;
  const kids = children.map((c) => ({
    spec: c.spec,
    exportName: c.exportName,
    importPath: c.importPath,
    sampleProps: c.sampleProps,
    className: `${pascal(c.spec.agentName)}Durable`,
    binding: scream(c.spec.agentName),
  }));

  const classByKind = new Map<string, { className: string; exportName: string }>();
  classByKind.set(root.spec.agentName, { className: rootClass, exportName: root.componentName });
  for (const k of kids) classByKind.set(k.spec.agentName, { className: k.className, exportName: k.exportName });

  // agentTool entries for a node: slot-named (prop key) first — those override a
  // plain nesting of the same kind — then plain kinds named by kind.
  const entriesFor = (agentName: string, plainKinds: string[]) => {
    const entries: { toolName: string; childKind: string }[] = [];
    const slotKinds = new Set<string>();
    for (const b of slots)
      if (b.provider === agentName) {
        entries.push({ toolName: b.toolName, childKind: b.childKind });
        slotKinds.add(b.childKind);
      }
    for (const kind of plainKinds)
      if (!slotKinds.has(kind)) entries.push({ toolName: toolIdent(kind), childKind: kind });
    return entries;
  };

  const nodeFrom = (
    isRoot: boolean,
    spec: AnyAgentSpec,
    exportName: string,
    importPath: string,
    className: string,
    binding: string,
    plainKinds: string[],
    sampleProps?: Record<string, unknown>,
  ): NodeInfo => ({
    isRoot,
    spec,
    exportName,
    importPath,
    className,
    binding,
    stateType: `${pascal(spec.agentName)}State`,
    propsConst: `${scream(spec.agentName)}_PROPS`,
    sampleProps,
    entries: entriesFor(spec.agentName, plainKinds),
    tools: staticToolsOfSpec(spec, sampleProps),
    diagnostics: thinkTargetDiagnostics(spec, sampleProps),
  });

  const nodes: NodeInfo[] = [
    nodeFrom(
      true,
      root.spec,
      root.componentName,
      root.componentImport,
      rootClass,
      scream(root.spec.agentName),
      subagentKindsFromAnalysis(analysis),
      root.spec.sampleProps,
    ),
    ...kids.map((k) =>
      nodeFrom(false, k.spec, k.exportName, k.importPath, k.className, k.binding, childKindsOfSpec(k), k.sampleProps)
    ),
  ];

  const hasAnyTool = nodes.some((n) => n.tools.length > 0);
  const hasAnyAgentTool = nodes.some((n) => n.entries.length > 0);
  const hasAnyGetTools = hasAnyTool || hasAnyAgentTool;
  const hasAnyModel = nodes.some((n) => Boolean(n.spec.model));

  // ── imports (conditional, so leaf/toolless emits stay minimal) ──
  const importLines = [`import { Think } from "@cloudflare/think";`];
  if (hasAnyAgentTool) importLines.push(`import { agentTool } from "agents/agent-tools";`);
  if (hasAnyTool) importLines.push(`import { tool, jsonSchema } from "ai";`);
  if (hasAnyGetTools) importLines.push(`import type { ToolSet } from "ai";`);
  if (hasAnyModel && opts.modelResolver)
    importLines.push(
      `import { ${opts.modelResolver.exportName} } from ${JSON.stringify(opts.modelResolver.importPath)};`,
    );
  importLines.push(`import { evaluateTree } from "${rt}/compile/evaluate.ts";`);
  importLines.push(
    hasAnyTool
      ? `import { collectInfra, collectPrompt } from "${rt}/tree.ts";`
      : `import { collectPrompt } from "${rt}/tree.ts";`
  );
  importLines.push(`import { renderPromptOrFallback } from "${rt}/prompt.ts";`);
  importLines.push(`import { withOutputs } from "${rt}/store.ts";`);
  importLines.push(`import type { AgentStore } from "${rt}/store.ts";`);
  if (hasAnyTool) importLines.push(`import type { InfraRecord } from "${rt}/types.ts";`);
  importLines.push(`import { ${root.componentName} } from "${root.componentImport}";`);
  for (const k of kids) importLines.push(`import { ${k.exportName} } from "${k.importPath}";`);

  const envEntries = nodes.map((n) => `  ${n.binding}: DurableObjectNamespace;`).join("\n");
  const modelEnvEntry = hasAnyModel ? "  AI: Ai;\n" : "";

  // ── shared Think base ──
  const toolRecordsMethod = hasAnyTool
    ? `
  /** This turn's static <tool> records (freshest run closures from the render). */
  protected toolRecords(): InfraRecord[] {
    const out: InfraRecord[] = [];
    for (const r of this.renderRoots()) collectInfra(r as never, out);
    return out.filter((r) => r.kind === "tool");
  }
`
    : "";
  const toolByNameMethod = hasAnyTool
    ? `
  /** A component <tool> → an AI-SDK tool. The <tool> intrinsic carries no input
   *  schema, so inputSchema is a permissive object (docs/think-target.md); the
   *  execute path re-renders to invoke the freshest run closure. */
  protected toolByName(name: string, description: string) {
    return tool({
      description,
      inputSchema: jsonSchema<Record<string, unknown>>({ type: "object", properties: {}, additionalProperties: true }),
      execute: async (input: Record<string, unknown>) => {
        const rec = this.toolRecords().find((r) => r.name === name);
        return String((await rec?.handlers.run?.(input)) ?? "");
      },
    });
  }
`
    : "";

  const base = `const PROMPT_BUDGET = ${budget};

/** Shared Think base: getSystemPrompt renders the component's context window over
 *  this.state; a bound store makes <tool> run closures durable. No reconcile loop
 *  — the model drives tool calls (agentTool spawns a child facet per tool-call). */
abstract class ThinkAgentBase<S extends Record<string, unknown>> extends Think<GeneratedEnv> {
  protected abstract renderTree(): unknown;
  protected abstract imperativePrompt(state: S): string;

  /** Per-turn composition props. They remain transient: Think persists the
   *  transcript/state, while the caller supplies the latest boundary input. */
  #activeTurn?: { token: object; props?: Record<string, unknown> };

  protected turnProps<T extends Record<string, unknown>>(fallback: T): T {
    return (this.#activeTurn?.props ?? fallback) as T;
  }

  /** Generated programmatic-turn bridge. Think owns durable chat, persistence,
   *  recovery, and streaming; callers receive the public text plus any model-
   *  supplied reasoning stream for progress/thought UI. */
  async runTurnWithTrace(input: string, props?: Record<string, unknown>) {
    let requestId = "";
    let text = "";
    let reasoning = "";
    let failure = "";
    let interrupted = false;
    const turnToken = {};
    try {
      await this.chat(() => {
        // Bind props only after Think admits this queued turn. Token ownership
        // prevents one interleaved RPC from clearing a newer turn's context.
        this.#activeTurn = { token: turnToken, props };
        return [{
          id: crypto.randomUUID(),
          role: "user" as const,
          parts: [{ type: "text" as const, text: input }],
        }];
      }, {
        onStart: (event) => { requestId = event.requestId; },
        onEvent: (json) => {
          const chunk = JSON.parse(json) as { type?: string; delta?: unknown; text?: unknown };
          const delta = typeof chunk.delta === "string"
            ? chunk.delta
            : typeof chunk.text === "string" ? chunk.text : "";
          switch (chunk.type) {
            case "text-delta": text += delta; break;
            case "reasoning-delta": reasoning += delta; break;
          }
        },
        onDone: () => {},
        onError: (error) => { failure = error; },
        onInterrupted: () => { interrupted = true; },
      });
    } finally {
      if (this.#activeTurn?.token === turnToken) this.#activeTurn = undefined;
    }
    if (failure) throw new Error(failure);
    if (interrupted) throw new Error("Think turn was interrupted before completion");
    return { requestId, text: text.trim(), reasoning: reasoning.trim() };
  }

  /** A store bridged to the DO: reads this.state, writes via setState (merge) —
   *  what makes a <tool> run closure's store.set(...) durable. */
  protected boundStore<T extends Record<string, unknown>>(): AgentStore<T> {
    return {
      get: () => this.state as unknown as T,
      set: (update) => {
        const prev = this.state as unknown as T;
        const next = typeof update === "function" ? (update as (p: T) => T)(prev) : { ...prev, ...update };
        this.setState(next as never);
      },
      subscribe: () => () => {},
      snapshot: () => JSON.stringify(this.state),
    };
  }

  /** Render this agent's tree with the continuation-outputs context bound to this
   *  DO's reserved __outputs slot (parity with reconcile mode's #renderRoots). */
  protected renderRoots(): unknown[] {
    const outputs = ((this.state as { __outputs?: Record<string, unknown> }) ?? {}).__outputs ?? {};
    return withOutputs({ outputs, setOutput: () => {} }, () => evaluateTree(this.renderTree()));
  }
${toolRecordsMethod}
  /** Think's system prompt = the component's <prompt> rendered over current state
   *  (priompt budget), else the spec's imperative getPrompt seam, else "".
   *  Re-derived each turn — Think calls getSystemPrompt() per model turn. */
  override getSystemPrompt(): string {
    const blocks = collectPrompt(this.renderRoots() as never);
    return renderPromptOrFallback(blocks, PROMPT_BUDGET, () => this.imperativePrompt(this.state as S));
  }
${toolByNameMethod}}`;

  // ── per-agent Think subclasses ──
  const emitClass = (n: NodeInfo): string => {
    const toolLines = [
      ...n.tools.map(
        (t) => `      ${identKey(t.name)}: this.toolByName(${JSON.stringify(t.name)}, ${JSON.stringify(t.description)}),`
      ),
      ...n.entries.map((e) => {
        const child = classByKind.get(e.childKind);
        if (!child) throw new Error(`emitThink: no class registered for child kind "${e.childKind}"`);
        return `      ${identKey(e.toolName)}: agentTool(${child.className}, { description: ${child.exportName}.spec.description ?? ${JSON.stringify(e.toolName)}, displayName: ${child.exportName}.spec.displayName, inputSchema: ${child.exportName}.spec.inputSchema, outputSchema: ${child.exportName}.spec.outputSchema }),`;
      }),
    ].join("\n");
    const getToolsBlock =
      n.entries.length || n.tools.length
        ? `

  override getTools(): ToolSet {
    return {
${toolLines}
    };
  }`
        : "";
    const initialState = n.isRoot
      ? `${JSON.stringify(n.spec.initialState)} as ${n.stateType}`
      : `{ ...${n.exportName}.spec.initialState } as ${n.stateType}`;
    const authoredModel = `${n.exportName}.spec.model ?? ${JSON.stringify(n.spec.model)}`;
    const resolvedModel = opts.modelResolver
      ? `${opts.modelResolver.exportName}(this.env, ${authoredModel})`
      : authoredModel;
    const modelBlock = n.spec.model
      ? `\n  override getModel() { return ${resolvedModel}; }`
      : `\n  // getModel() inherits Think's throwing default; consumers may override it.`;
    const diagComment = n.diagnostics.length
      ? `${formatTargetDiagnosticsForComment(n.diagnostics)}\n`
      : "";
    const structuredOutputBlock = n.spec.outputSchema
      ? `

  /** Native agentTool structured result: parse the child turn's final text
   *  through the component's output contract. agentTool validates it again at
   *  the parent boundary before returning it to the model. */
  protected override getAgentToolOutput(runId: string): unknown {
    const text = super.getAgentToolSummary(runId, undefined);
    if (!text) return undefined;
    let value: unknown = text;
    try { value = JSON.parse(text); } catch { /* schema reports the mismatch */ }
    return ${n.exportName}.spec.outputSchema?.parse(value);
  }`
      : "";
    return `// ---------------------------------------------------------------------------
// ${n.isRoot ? "Root" : "Child"} agent: ${n.spec.agentName}${n.isRoot ? "" : ` (from ${n.importPath})`}
type ${n.stateType} = typeof ${n.exportName}.spec.initialState & Record<string, unknown>;
const ${n.propsConst} = ${JSON.stringify(n.sampleProps ?? n.spec.sampleProps ?? {})} as const;

${diagComment}export class ${n.className} extends ThinkAgentBase<${n.stateType}> {
  initialState = ${initialState};${modelBlock}
  protected renderTree(): unknown {
    return ${n.exportName}.spec.impl({ ...this.turnProps(${n.propsConst}), store: this.boundStore<${n.stateType}>(), emit: () => {} } as never);
  }
  protected imperativePrompt(state: ${n.stateType}): string {
    return ${n.exportName}.spec.getPrompt?.(state) ?? "";
  }${structuredOutputBlock}${getToolsBlock}
}`;
  };

  const agents = `// GENERATED by agent-jsx (compile target: cloudflare/agents — THINK mode). Do not edit.
// You wrote: ${root.componentImport}${kids.map((k) => `, ${k.importPath}`).join("")}
// Derived Think glue: getSystemPrompt (the rendered context window), getTools
// (child boundaries -> agentTool, static <tool> -> tool). One Think subclass per
// agent; the MODEL drives delegation (no reconcile loop). See docs/think-target.md.

${importLines.join("\n")}

export interface GeneratedEnv {
${modelEnvEntry}${envEntries}
}

${base}

${nodes.map(emitClass).join("\n\n")}
`;

  const wrangler = `// GENERATED by agent-jsx (THINK mode) — merge into wrangler.jsonc
{
${hasAnyModel ? `  "ai": { "binding": "AI" },\n` : ""}  "durable_objects": {
    "bindings": [
${nodes.map((n) => `      { "name": "${n.binding}", "class_name": "${n.className}" }`).join(",\n")}
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [${nodes.map((n) => `"${n.className}"`).join(", ")}]
    }
  ]
}
`;

  if (opts.emitRuntimeTo) emitRuntimeFiles(opts.emitRuntimeTo);

  return { agents, wrangler };
}
