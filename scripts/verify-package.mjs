import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageName = packageJson.name;

const entrypoints = [
  [`${packageName}/agent`, ["Agent", "callable", "compileAgentClass", "composeAgent", "result"]],
  [`${packageName}/agent-component`, ["Agent", "agentComponent", "compileAgent", "defineAgentProfile"]],
  [`${packageName}/compile/emit-agent-module`, ["emitAgentModule"]],
  [`${packageName}/compile/cloudflare`, [
    "analyzeAgent",
    "discoverAgents",
    "discoverToolSlots",
    "emitCloudflare",
    "emitThink",
  ]],
  [`${packageName}/goal`, ["buildGoalTable", "goalInit", "goalReducer"]],
  [`${packageName}/jsx-runtime`, ["Fragment", "jsx", "jsxs"]],
  [`${packageName}/jsx-dev-runtime`, ["Fragment", "jsxDEV"]],
];

for (const [specifier, expectedExports] of entrypoints) {
  const module = await import(specifier);
  for (const expectedExport of expectedExports) {
    assert.ok(expectedExport in module, `${specifier} must export ${expectedExport}`);
  }
}

console.log(`Verified ${entrypoints.length} package entrypoints with Node.js.`);
