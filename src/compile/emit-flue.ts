/**
 * Compile target #2: flue.
 *
 * Flue's authoring model is eager/static (defineAgent values; @flue/jsx was
 * constructor sugar over it), so the split matters here:
 *   - the STATIC slice (prompt at rest, always-on tools/schedules) compiles
 *     to a defineAgent module;
 *   - the DYNAMIC slice (state-gated subagents/tools) compiles to a
 *     spawnPlan(state) function — the exact shape flue's own design doc
 *     proposed (plans/2026-06-29-jsx-render-prop-subagents.md: "declarative
 *     sugar over dynamic spawn — not a lazy subtree"), with the stable-id
 *     requirement satisfied by our mandatory `name` prop.
 *
 * Emitted as `.ts`, never `.tsx` — flue's discoverModules matches
 * \.(ts|js|mts|mjs)$ only; the .tsx gap is what killed @flue/jsx adoption.
 *
 * API note: `defineAgent`'s initializer returns an `AgentRuntimeConfig`, which
 * has NO `name` field (name comes from the module/route). See COMPAT-REPORT.md
 * — the earlier `name:` guess was an excess property and is removed here.
 */

import { renderPromptOrFallback } from "../prompt.ts";
import { collectInfra, collectPrompt } from "../tree.ts";
import { createStore } from "../store.ts";
import { evaluateComponent } from "./evaluate.ts";
import { emitRuntimeFiles } from "./runtime-files.ts";
import {
  flueChildTargetDiagnostics,
  formatTargetDiagnosticsForComment,
} from "./target-diagnostics.ts";
import type { AnyAgentSpec } from "../agent-component.tsx";
import type { Analysis } from "./analyze.ts";
import type { ChildAgentSpec } from "./emit-cloudflare.ts";
import type { ToolSlotBinding } from "./slots.ts";

export interface FlueEmitOptions {
  /** The parent agent's spec — the SAME `agentComponent(spec)` the cloudflare
   *  emitter consumes. Supplies agentName, initialState, sampleProps (the flue
   *  task input / resting props), impl (resting render), and the getPrompt seam.
   *  The resting instructions are derived from the spec, not a passed element. */
  spec: AnyAgentSpec;
  /** Overrides the authored profile model for this target. Legacy
   * agentComponent specs without a model must still pass this explicitly. */
  model?: string;
  /** Export name + import path of the agentComponent — imported for spawnPlan's
   *  `.spec.impl` and structural state typing. */
  componentName: string;
  componentImport: string;
  analysis: Analysis;
  /** Generated child profile modules this parent should expose to flue task delegation. */
  childProfiles?: { importPath: string; profileExportName: string }[];
  /** Explicit tool-slot bindings. Flue indexes subagents only by profile.name,
   *  so each prop-key capability is emitted as a validated alias profile. */
  toolSlots?: ToolSlotBinding[];
  promptBudget?: number;
  /** Rewrites the generated runtime imports off `../../src` (e.g. "./runtime"). */
  runtimeImport?: string;
  /** Absolute fs path; when set, the react-free runtime file set is copied here. */
  emitRuntimeTo?: string;
}

export interface FlueChildOptions {
  /** Rewrites the generated runtime imports off `../../src` (e.g. "./runtime").
   *  Only used when this profile nests its own children — its spawn plan needs
   *  the evaluate/collect/store runtime. A leaf profile imports no runtime. */
  runtimeImport?: string;
  /** When this profile itself nests children: their generated profile modules,
   *  declared as native flue `subagents:` on THIS profile (the mid-level of the
   *  static hierarchy — a `defineAgentProfile` carrying a subagents array,
   *  exactly flue's sketch). The parent imports each from the child's module. */
  childProfiles?: { importPath: string; profileExportName: string }[];
  /** This profile's own static/dynamic split. Its dynamic nested boundaries
   *  (a prop-gated `.map`) become the DYNAMIC-residue spawn plan; static ones
   *  live on `subagents:`. */
  analysis?: Analysis;
}

export function flueProfileExportName(agentName: string): string {
  return `${flueIdentifier(agentName)}Profile`;
}

function flueIdentifier(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

/**
 * A child agent component → a standalone flue agent profile module. The
 * child's resting <prompt> becomes its instructions; the parent exposes it
 * as a delegation target (flue's harness turns subagents into tools).
 * Props/callbacks note: flue delegation is task-based — parent props become
 * the task input; the callback becomes the awaited task result.
 */
export function emitFlueChild(child: ChildAgentSpec, promptBudget = 400, opts: FlueChildOptions = {}): string {
  const { spec } = child;
  const sampleProps = child.sampleProps ?? spec.sampleProps ?? {};
  const rt = opts.runtimeImport ?? "../../src";
  const profileExport = flueProfileExportName(spec.agentName);
  // Profile description pass-through: `defineAgentProfile` accepts `description`
  // (flue AgentProfile), so the child's spec.description travels into the flue
  // delegation roster — the contract a parent's `subagents:` exposes to the
  // model. Empty when absent, so schemaless profiles stay byte-identical.
  const descriptionLine = spec.description
    ? `  description: ${JSON.stringify(spec.description)},\n`
    : "";
  const modelLine = spec.model
    ? `  model: ${JSON.stringify(spec.model)},\n`
    : "";
  const hasSkills = (spec.skills?.length ?? 0) > 0;
  const skillsLine = hasSkills
    ? `  skills: ${child.exportName}.spec.skills as never,\n`
    : "";
  const diagnostics = formatTargetDiagnosticsForComment(flueChildTargetDiagnostics(child));
  const roots = evaluateComponent(spec.impl, {
    ...sampleProps,
    store: createStore(spec.initialState),
  } as never);
  // Resting instructions: the <prompt> tree if present, else the imperative
  // getPrompt seam at initial state, else empty (agent-jsx part B).
  const instructions = renderPromptOrFallback(
    collectPrompt(roots),
    promptBudget,
    () => spec.getPrompt?.(spec.initialState) ?? ""
  );

  const childProfiles = opts.childProfiles ?? [];

  // Leaf profile: a plain task-delegation profile (props = task input, callback
  // = task result). No nested children, no runtime.
  if (childProfiles.length === 0) {
    return `// GENERATED by agent-jsx (compile target: flue, child agent). Do not edit.
// Source component: ${child.importPath} (${child.exportName})
${diagnostics ? `${diagnostics}\n` : ""}

import { defineAgentProfile } from "@flue/runtime";
${hasSkills ? `import { ${child.exportName} } from "${child.importPath}";\n\n` : "\n"}export const ${profileExport} = defineAgentProfile({
  name: ${JSON.stringify(spec.agentName)},
${descriptionLine}${modelLine}${skillsLine}  instructions: ${JSON.stringify(instructions)},
  // Parent props arrive as the delegated task input; the child's onResult
  // callback is realized as the task RETURN value (flue's session.task).
});
`;
  }

  // Mid-level profile: it nests its OWN children. Emit native `subagents:` (the
  // static hierarchy — a defineAgentProfile carrying a subagents array, exactly
  // flue's sketch) plus a DYNAMIC-residue spawn plan for prop-gated fan-out.
  const childImports = childProfiles
    .map((c) => `import { ${c.profileExportName} } from "${c.importPath}";`)
    .join("\n");
  const subagentsList = childProfiles.map((c) => c.profileExportName).join(", ");

  const dynamicSubagents = (opts.analysis?.dynamic ?? []).filter((r) => r.kind === "subagent");
  const staticSubagentNames = (opts.analysis?.static ?? [])
    .filter((r) => r.kind === "subagent")
    .map((r) => r.name);

  const runtimeImports = dynamicSubagents.length
    ? `import { evaluateTree } from "${rt}/compile/evaluate.ts";
import { collectInfra } from "${rt}/tree.ts";
import { createStore, withOutputs } from "${rt}/store.ts";
import { ${child.exportName} } from "${child.importPath}";
`
    : hasSkills
      ? `import { ${child.exportName} } from "${child.importPath}";\n`
      : "";

  const spawnPlanBlock = dynamicSubagents.length
    ? `
// State derived structurally from the component spec.
type State = typeof ${child.exportName}.spec.initialState & Record<string, unknown>;
const PROPS = ${JSON.stringify(sampleProps)};

/**
 * Dynamic residue (${dynamicSubagents.map((r) => `${r.kind}:${r.name}`).join(", ")}): this profile fans out one
 * nested child per item in its delegated INPUT (a \`.map\` over pushed-down
 * props). flue's static profile text cannot encode that count, so the
 * deterministic plan is a function of the task input. Static nested children
 * are declared on \`subagents\` above and excluded here by stable id.
 */
const STATIC_SUBAGENTS = new Set(${JSON.stringify(staticSubagentNames)});
export function spawnPlan(input: Record<string, unknown> = PROPS, state: State = ${child.exportName}.spec.initialState as State) {
  const store = createStore<State>(state);
  // Continuation grandchildren expand from the reserved __outputs slot once a
  // child's emit has landed; \`emits\` marks a boundary whose delegate resolves a
  // structured output.
  const outputs = (state as { __outputs?: Record<string, unknown> }).__outputs ?? {};
  const desired = withOutputs({ outputs, setOutput: () => {} }, () =>
    evaluateTree(${child.exportName}.spec.impl({ ...PROPS, ...input, store, emit: () => {} } as never))
  ).flatMap((root) => collectInfra(root));
  return desired
    .filter((r) => r.kind === "subagent" && !STATIC_SUBAGENTS.has(r.name))
    .map((r) => {
      const { kind, ...childInput } = r.config;
      return {
        stableId: r.name,
        agent: String(kind),
        input: childInput,
        emits: r.bindings?.__emit?.kind === "continuation",
        bindings: r.bindings ?? {},
        resultBinding: Object.entries(r.bindings ?? {}).find(([, b]) => b.kind === "result")?.[0] ?? null,
        target: r.target ?? null,
      };
    });
}
`
    : "";

  return `// GENERATED by agent-jsx (compile target: flue, child agent). Do not edit.
// Source component: ${child.importPath} (${child.exportName})
${diagnostics ? `${diagnostics}\n` : ""}

import { defineAgentProfile } from "@flue/runtime";
${runtimeImports}${childImports}

export const ${profileExport} = defineAgentProfile({
  name: ${JSON.stringify(spec.agentName)},
${descriptionLine}${modelLine}${skillsLine}  instructions: ${JSON.stringify(instructions)},
  // Nested subagent profiles — this level's static hierarchy as flue's native
  // \`subagents:\` array (defineAgentProfile carrying subagents, exactly the
  // sketch). session.task(..., { agent }) resolves them.
  subagents: [${subagentsList}],
});
${spawnPlanBlock}`;
}

export function emitFlue(o: FlueEmitOptions): string {
  const rt = o.runtimeImport ?? "../../src";
  const spec = o.spec;
  const model = o.model ?? spec.model;
  if (!model) {
    throw new Error(
      `[agent-jsx] flue agent "${spec.agentName}" needs profile.model or FlueEmitOptions.model`
    );
  }
  const childProfiles = o.childProfiles ?? [];
  const slotBindings = (o.toolSlots ?? []).filter((binding) => binding.provider === spec.agentName);
  // Resting instructions derived from the spec: the <prompt> tree rendered at
  // the initial state if present, else the imperative getPrompt seam, else "".
  const restingRoots = evaluateComponent(spec.impl, {
    ...(spec.sampleProps ?? {}),
    store: createStore(spec.initialState),
  } as never);
  const instructions = renderPromptOrFallback(
    collectPrompt(restingRoots),
    o.promptBudget ?? 400,
    () => spec.getPrompt?.(spec.initialState) ?? ""
  );

  // STATIC <tool> records (present at the resting render) → flue tools. This is
  // the flue analogue of think mode's getTools()[name] = tool(...): the same
  // <tool> a Think agent registers, exposed to flue's harness via defineTool.
  // description-only pass-through (the <tool> intrinsic carries no input schema,
  // and defineTool.input is optional) — see docs/think-target.md. State-gated
  // (dynamic) tools stay out (flue has no state→render loop), so uptime's
  // page-oncall is byte-identical (no tools block).
  const staticTools: { name: string; description: string }[] = [];
  const seenTools = new Set<string>();
  for (const root of restingRoots)
    for (const rec of collectInfra(root))
      if (rec.kind === "tool" && !seenTools.has(rec.name)) {
        seenTools.add(rec.name);
        staticTools.push({ name: rec.name, description: String(rec.config.description ?? "") });
      }
  const flueImports = ["defineAgent"];
  if (staticTools.length) flueImports.push("defineTool");
  if (slotBindings.length) flueImports.push("defineAgentProfile");
  const flueImport = `import { ${flueImports.join(", ")} } from "@flue/runtime";`;
  const toolsBlock = staticTools.length
    ? `  // Static <tool> records → flue tools (the flue analogue of think mode's
  // getTools). defineTool.input is omitted (the <tool> intrinsic carries no input
  // schema — description-only pass-through, see docs/think-target.md); the run
  // re-renders at rest to invoke the freshest closure (closures never serialize).
  // A <tool> store.set side effect is not persisted — flue tools are session-
  // scoped, not agent-state-backed.
  tools: [
${staticTools
        .map(
          (t) => `    defineTool({
      name: ${JSON.stringify(t.name)},
      description: ${JSON.stringify(t.description)},
      run: async (context) => {
        const store = createStore<State>(${o.componentName}.spec.initialState as State);
        const rec = withOutputs({ outputs: {}, setOutput: () => {} }, () =>
          evaluateTree(${o.componentName}.spec.impl({ ...PROPS, store, emit: () => {} })),
        )
          .flatMap((root) => collectInfra(root))
          .find((r) => r.kind === "tool" && r.name === ${JSON.stringify(t.name)});
        const input = (context as { input?: Record<string, unknown> }).input ?? {};
        return String((await rec?.handlers.run?.(input)) ?? "");
      },
    }),`
        )
        .join("\n")}
  ],`
    : `  // No static tools: the component's <tool> is state-gated (e.g. page-oncall
  // only during an incident). Surface it per-turn via the harness rather than
  // as an always-on definition tool. flue has no sensor primitive either —
  // poll sensors belong in a flue workflow (cron) that calls session.prompt
  // with fresh observations.`;

  const dynamicKinds = o.analysis.dynamic.map((r) => `${r.kind}:${r.name}`);
  // STATIC subagent boundaries are declared as native flue `subagents:` on the
  // agent above. The spawn plan is the DYNAMIC residue ONLY, so exclude them by
  // stable id. Empty for a root with no static children (byte-identical output).
  const staticSubagentNames = o.analysis.static
    .filter((r) => r.kind === "subagent")
    .map((r) => r.name);
  const staticDecl = staticSubagentNames.length
    ? `// Static nested subagents are declared on \`subagents\` above (flue's native\n// hierarchy); the plan is the dynamic residue only, so exclude them by id.\nconst STATIC_SUBAGENTS = new Set(${JSON.stringify(staticSubagentNames)});\n`
    : "";
  const staticFilter = staticSubagentNames.length ? " && !STATIC_SUBAGENTS.has(r.name)" : "";
  const childImports = childProfiles
    .map((c) => `import { ${c.profileExportName} } from "${c.importPath}";`)
    .join("\n");
  const aliases = slotBindings.map((binding) => {
    const source = childProfiles.find(
      (profile) => profile.profileExportName === flueProfileExportName(binding.childKind)
    );
    if (!source) {
      throw new Error(`flue tool slot: no child profile registered for kind "${binding.childKind}"`);
    }
    return {
      binding,
      source,
      alias: `${flueIdentifier(binding.toolName)}SubagentProfile`,
    };
  });
  const aliasBlock = aliases.length
    ? `// Flue resolves session.task({ agent }) strictly by AgentProfile.name.
// Generate one validated alias per explicit JSX prop-key capability so the
// model-visible grant is the binding name, not an accidental child kind.
${aliases
  .map(
    ({ binding, source, alias }) =>
      `export const ${alias} = defineAgentProfile({ ...${source.profileExportName}, name: ${JSON.stringify(binding.toolName)} });`
  )
  .join("\n")}
`
    : "";
  const slottedExports = new Set(aliases.map((alias) => alias.source.profileExportName));
  const plainKinds = new Set(
    [...o.analysis.static, ...o.analysis.dynamic]
      .filter((record) => record.kind === "subagent")
      .map((record) => String(record.config.kind))
  );
  const roster = [
    ...childProfiles
      .filter(
        (profile) =>
          !slottedExports.has(profile.profileExportName) ||
          [...plainKinds].some((kind) => flueProfileExportName(kind) === profile.profileExportName)
      )
      .map((profile) => profile.profileExportName),
    ...aliases.map((alias) => alias.alias),
  ];
  const subagentsLine =
    roster.length > 0
      ? `  // Explicit subagent/capability roster for session.task(..., { agent }).\n  subagents: [${roster.join(", ")}],\n`
      : "";
  const skillsLine = (spec.skills?.length ?? 0) > 0
    ? `  skills: ${o.componentName}.spec.skills as never,\n`
    : "";

  const module = `// GENERATED by agent-jsx (compile target: flue). Do not edit.
// Plain .ts on purpose: flue's discoverModules excludes .tsx — a discovered
// .ts entry importing the .tsx component is the sanctioned pattern.
//
// Static instructions below are the component's <prompt> rendered at the
// resting state. Live context (incidents etc.) is dynamic — re-render the
// component per turn and pass renderPrompt(...) as the task context instead
// of baking it here.

${flueImport}
import { evaluateTree } from "${rt}/compile/evaluate.ts";
import { collectInfra } from "${rt}/tree.ts";
import { createStore, withOutputs } from "${rt}/store.ts";
import { ${o.componentName} } from "${o.componentImport}";
${childImports}
${aliasBlock}

// State + props derived structurally from the component spec (no state-type
// string, no per-emit propsJson): the spec is the single analyzed source.
type State = typeof ${o.componentName}.spec.initialState & Record<string, unknown>;
const PROPS = ${JSON.stringify(spec.sampleProps ?? {})};

// defineAgent's initializer returns an AgentRuntimeConfig (model/instructions/
// tools/subagents/…). No \`name\` field — flue derives the agent name from the
// module/route, not the config object.
export default defineAgent(() => ({
  model: ${JSON.stringify(model)},
  instructions: ${JSON.stringify(instructions)},
${skillsLine}${subagentsLine}
${toolsBlock}
}));

/**
 * Dynamic residue${dynamicKinds.length ? ` (${dynamicKinds.join(", ")})` : ""}: flue's runtime has no state→render
 * loop, so state-gated children compile to a spawn plan the orchestrating
 * workflow calls after each state change. Stable ids come from \`name\` —
 * "the #1 production bug" per flue's render-prop plan, solved by contract.
 * Child props are spread into the boundary config, so the delegated task input
 * is config minus the reserved \`kind\` discriminator.
 */
${staticDecl}export function spawnPlan(state: State) {
  const store = createStore<State>(state);
  // Continuation grandchildren expand from the reserved __outputs slot: once a
  // child's emit has landed in state.__outputs, this plan fans out the boundary's
  // render-prop children (the workflow round that folded the emit calls spawnPlan
  // again). \`emits\` marks a boundary whose delegate resolves a structured output.
  const outputs = (state as { __outputs?: Record<string, unknown> }).__outputs ?? {};
  // .spec.impl renders the agent's OWN tree; a bare component call would be a
  // subagent boundary (parent composition), collapsing the whole plan to one.
  const desired = withOutputs({ outputs, setOutput: () => {} }, () =>
    evaluateTree(${o.componentName}.spec.impl({ ...PROPS, store, emit: () => {} }))
  ).flatMap((root) => collectInfra(root));
  return desired
    .filter((r) => r.kind === "subagent"${staticFilter})
    .map((r) => {
      const { kind, ...input } = r.config;
      return {
        stableId: r.name,
        agent: String(kind),
        input,
        emits: r.bindings?.__emit?.kind === "continuation",
        bindings: r.bindings ?? {},
        resultBinding: Object.entries(r.bindings ?? {}).find(([, b]) => b.kind === "result")?.[0] ?? null,
        target: r.target ?? null,
      };
    });
}
`;

  if (o.emitRuntimeTo) emitRuntimeFiles(o.emitRuntimeTo);

  return module;
}

export interface FlueWorkflowOptions {
  /** The workflow agent's spec — supplies agentName (the agent binding),
   *  initialState (the input fallback), sampleProps (props), and impl (the
   *  component the reactive loop re-evaluates each round). */
  spec: AnyAgentSpec;
  componentName: string;
  /** Import path to the .tsx component (bun/flue resolve a .ts→.tsx import). */
  componentImport: string;
  /** The generated defineAgent module — its DEFAULT export is the workflow agent. */
  agentModuleImport: string;
  /** Rewrites the runtime import off `../../src` (e.g. "./runtime"). */
  runtimeImport?: string;
  /** Absolute fs path; when set, the react-free runtime file set is copied here. */
  emitRuntimeTo?: string;
}

/**
 * The flue-side completer for v0.5's dynamic residue: a real `defineWorkflow`
 * whose run() drives `runReactiveWorkflow`, with `delegate` wired to
 * `session.task`. flue has no state→render loop, so this workflow IS the loop —
 * it re-evaluates the component per round and delegates fresh `<subagent>`
 * records until the composition is at rest.
 *
 * Verified against the REAL @flue/runtime (~/dev/flue, read-only), see
 * COMPAT-REPORT.md #12–#15:
 *   - `defineWorkflow({ agent, input, run })` folds run() into an `action` and
 *     returns a frozen `{ __flueWorkflowDefinition, agent, action }`
 *     (workflow-definition.ts:52-105). `agent` must pass `isAgentDefinition`,
 *     so we import the generated `defineAgent` module's default export.
 *   - run() receives an `ActionContext = { harness, log, input }`
 *     (action.ts:18-23) — NOT `{ harness, input }` verbatim; `session` is
 *     obtained via `context.harness.session()` (types.ts:462-469).
 *   - `input` MUST be a top-level object schema; `defineAction` throws
 *     otherwise (action.ts:83-85, schema.ts:42-45). `v.object(...)` qualifies;
 *     state is nested under `{ state }`.
 *   - delegation: `session.task(text, { agent }) → { text }`
 *     (types.ts:552-556 task, :674-683 TaskOptions.agent, :620-627 PromptResponse).
 */
export function emitFlueWorkflow(o: FlueWorkflowOptions): string {
  const rt = o.runtimeImport ?? "../../src";
  const spec = o.spec;
  const agentBinding = `${flueIdentifier(spec.agentName)}Agent`;

  const module = `// GENERATED by agent-jsx (compile target: flue, reactive workflow). Do not edit.
// Plain .ts on purpose: flue's discoverModules excludes .tsx — a discovered
// .ts entry importing the .tsx component is the sanctioned pattern.
//
// flue has no state→render loop, so this workflow's run() IS the loop: it
// drives runReactiveWorkflow, which re-evaluates the component each round,
// delegates every fresh <subagent> via session.task, and folds each result
// back through that record's onResult until the composition is at rest.
//
// Real flue API shape (verified against ~/dev/flue, read-only):
//   - defineWorkflow({ agent, input, run }) folds run() into \`action\` and
//     returns a frozen { __flueWorkflowDefinition, agent, action }
//     (workflow-definition.ts:52-105). \`agent\` must pass isAgentDefinition,
//     hence the generated defineAgent module's default export.
//   - run(context) receives an ActionContext = { harness, log, input }
//     (action.ts:18-23); the session comes from context.harness.session()
//     (types.ts:462-469), NOT a top-level \`session\`.
//   - \`input\` MUST be a top-level object schema or defineAction throws
//     (action.ts:83-85; schema.ts:42-45 accepts type 'object'), so state is
//     nested under { state }.
//   - delegation is session.task(text, { agent }) → { text }
//     (types.ts:552-556, :674-683, :620-627).

import * as v from "valibot";
import { defineWorkflow } from "@flue/runtime";
import { runReactiveWorkflow } from "${rt}/workflow-executor.ts";
import ${agentBinding} from "${o.agentModuleImport}";
import { ${o.componentName} } from "${o.componentImport}";

// State + props derived structurally from the component spec (no state-type
// string, no initial-state-export import, no per-emit propsJson).
type State = typeof ${o.componentName}.spec.initialState & Record<string, unknown>;
const PROPS = ${JSON.stringify(spec.sampleProps ?? {})};

export default defineWorkflow({
  agent: ${agentBinding},
  // Top-level v.object is a flue load-time rule (defineAction validates the
  // schema is a top-level object). The reactive turn enters at a caller-supplied
  // state — what the sensor/poll turn produced — nested under { state }.
  input: v.object({ state: v.any() }),
  run: async (context) => {
    const session = await context.harness.session();
    const initialState = (context.input.state ?? ${o.componentName}.spec.initialState) as State;
    return runReactiveWorkflow({
      // .spec.impl renders the agent's OWN tree each round (a bare component
      // call would be a subagent boundary — parent composition).
      component: ${o.componentName}.spec.impl,
      props: PROPS,
      initialState,
      // Each SpawnDescriptor { stableId, agent, input } → one delegated flue
      // task. The subagent kind selects the named subagent profile; the task's
      // result text is folded back into state through the record's onResult.
      delegate: async (descriptor) => {
        const response = await session.task(
          \`Run "\${descriptor.stableId}" with the "\${descriptor.agent}" agent. Input: \${JSON.stringify(descriptor.input)}.\`,
          { agent: descriptor.agent },
        );
        return response.text;
      },
    });
  },
});
`;

  if (o.emitRuntimeTo) emitRuntimeFiles(o.emitRuntimeTo);

  return module;
}
