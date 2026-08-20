---
"@agent-jsx/core": minor
---

Add `@agent-jsx/core/instruction` — an eager, document-only JSX runtime (`JSX.Element = string`) with `System`/`Section`/`P`/`List`/`Code` components for authoring flue 2.0 instruction documents. Components are plain functions returning strings, so `return <System>…</System>` collapses into the plain string flue 2.0's agent return contract expects, with no flue changes. Opt in per file with `@jsxImportSource @agent-jsx/core/instruction`.
