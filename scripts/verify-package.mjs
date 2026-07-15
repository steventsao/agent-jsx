import assert from "node:assert/strict";

const entrypoints = [
  ["@steventsao/agent-jsx/agent", ["Agent", "callable", "compileAgentClass", "composeAgent", "result"]],
  ["@steventsao/agent-jsx/agent-component", ["Agent", "agentComponent", "compileAgent"]],
  ["@steventsao/agent-jsx/compile/emit-agent-module", ["emitAgentModule"]],
  ["@steventsao/agent-jsx/jsx-runtime", ["Fragment", "jsx", "jsxs"]],
  ["@steventsao/agent-jsx/jsx-dev-runtime", ["Fragment", "jsxDEV"]],
];

for (const [specifier, expectedExports] of entrypoints) {
  const module = await import(specifier);
  for (const expectedExport of expectedExports) {
    assert.ok(expectedExport in module, `${specifier} must export ${expectedExport}`);
  }
}

console.log(`Verified ${entrypoints.length} package entrypoints with Node.js.`);
