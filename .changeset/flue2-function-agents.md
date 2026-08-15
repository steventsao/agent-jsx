---
"@steventsao/agent-jsx": minor
---

Add a flue 2.0 compile target. `emitFlue2` emits a `'use agent'` function module that forwards the authored class and flue 2.0 hooks to the new react-free `renderFlue2Agent` runtime: every flue turn re-renders the agent against durable `usePersistentState`, so the instruction and tool surface are derived state that updates dynamically per state change — no compile-time evaluation for this target. Includes the `compat/flue2` suite validating generated modules against the real `@flue/runtime` 2.0.x type surface and module loader.
