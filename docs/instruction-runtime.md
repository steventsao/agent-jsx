# The instruction runtime: JSX documents for flue 2.0 agents

`@agent-jsx/core/instruction` is an eager, document-only JSX runtime where `JSX.Element` *is*
`string`. Components are plain functions returning strings; there is no reconciler and no
element tree — a JSX expression collapses bottom-up into the finished instruction document the
moment it evaluates.

## Why this exists

Flue 2.0 rewrote agent authoring around hooks: the exported agent function re-runs before every
model call, capabilities are declared by calling `useModel` / `useTool` / `useSkill` /
`useSubagent` in the body, and the function's **return value is the instruction document as a
plain string** (the runtime's check is `typeof value === "string"`).

That split is principled — the model reads the return value, the harness reads the hook frame —
but it inverts React twice, and the second inversion gives up something real:

1. **Hooks may be conditional, by design.** Flue has no positional hook slots to corrupt:
   durable state is keyed by explicit name, resources (tools/skills/subagents) are name-keyed
   sets whose per-render changes are diffed and narrated to the model, and the invariants that
   do matter (`useModel` exactly once, `useDataWriter` names render-invariant) throw
   explicitly. React's "no hooks in conditionals" rule protects an implementation detail flue
   doesn't have.
2. **But the return value is a bare string.** The one output where *order and structure are
   the meaning* — the prose document — gets no composition story: document order smears across
   hook call order (`useInstruction` contributions land wherever a custom hook happened to
   run), and shared prose fragments are string concatenation.

The instruction runtime keeps flue's hooks for capabilities and gives the return value the
composition model it deserves. Because every component returns a string,
`return <System>…</System>` **already is** the string flue expects by the time `return`
executes — zero flue changes, no build coupling beyond `jsxImportSource`. As a side effect the
last order-sensitivity leaves the hook layer entirely: hooks stay order-free name-keyed sets,
and *all* document ordering lives visibly in one tree.

## Usage

```tsx
/** @jsxImportSource @agent-jsx/core/instruction */
"use agent";
import { useInitialData, useModel, useTool } from "@flue/runtime";
import { List, Section, System } from "@agent-jsx/core/instruction";

export function Assistant() {
  useModel("anthropic/claude-haiku-4-5");
  const data = useInitialData<{ contactName?: string }>();
  useTool(postMessage(refFor(data)));
  return (
    <System>
      Reply concisely in the conversation{data?.contactName && ` with ${data.contactName}`}.
      <Section title="Style">
        <List items={["plain text only", "no markdown headers in replies"]} />
      </Section>
    </System>
  );
}
```

## Rendering rules

- **Inline concatenates, blocks self-separate.** Text and `{expressions}` join with no
  separator (`Reply to {name}.` stays one sentence). Block components (`Section`, `P`, `List`,
  `Code`) prefix themselves with one paragraph break and never end with one; `System` trims
  the document and collapses accidental blank-line runs.
- **Conditionals are plain JSX**: `{cond && <Section …/>}` renders or vanishes —
  `null`/`undefined`/booleans render as nothing, numbers stringify, arrays flatten.
- **JSX text follows JSX semantics**: multi-line prose inside an element joins with single
  spaces. For verbatim line breaks, pass a template literal — `<Code>` exists for exactly
  this.
- **A component is any function returning a string.** No registration, no context: compose
  house components (`<Persona>`, `<Guardrails>`, …) as ordinary functions over the
  primitives.

## Primitives

| Component                | Renders                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `<System>`               | the document root — trimmed, blank-line-normalized plain string  |
| `<Section title level?>` | `## Title` (heading depth = `level`, default 2) plus content     |
| `<P>`                    | an explicit paragraph                                            |
| `<List items? ordered?>` | markdown list; `items` prop for dynamic, JSX children for static |
| `<Code lang?>`           | fenced code block, content verbatim                              |

## Relationship to the rest of the package

- The `<prompt>`/`<sys>`/`<msg>` intrinsics are the **compiled, budget-aware context layer**:
  priompt-style priorities rendered under a token budget at runtime (`src/prompt.ts`). The
  instruction runtime is the **authoring layer** for handwritten flue 2.0 hook agents, where
  the document must leave the agent function as a plain string. They are complementary, not
  competing.
- It is a **separate import source** from the package's data runtime on purpose:
  `jsx-runtime` builds lazy `{ type, props }` DataElements for the compiler to walk;
  `instruction/jsx-runtime` is eager and stringly. Mixing them in one file is a type error by
  construction (`Element = string` vs `Element = DataElement`).
- `compile/emit-flue` still targets flue 1.x (`defineAgent` / `defineAgentProfile`), which
  flue 2.0 removed. The instruction runtime is the first 2.0-compatible piece; a hooks-era
  emitter (static slice → hook declarations, dynamic slice → conditional hooks, prompt tree →
  a `<System>` return) is the natural follow-up.
