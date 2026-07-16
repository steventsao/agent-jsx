import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});
const packResults = JSON.parse(packOutput);

assert.equal(packResults.length, 1, "npm pack must produce exactly one package");

const [packResult] = packResults;
assert.equal(packResult.name, packageJson.name, "packed package name must match package.json");
assert.equal(packResult.version, packageJson.version, "packed version must match package.json");

const packedFiles = new Set(packResult.files.map(({ path }) => path));
const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"]);

for (const path of allowedRootFiles) {
  assert.ok(packedFiles.has(path), `npm tarball must contain ${path}`);
}

for (const path of packedFiles) {
  assert.ok(
    path.startsWith("dist/") || allowedRootFiles.has(path),
    `npm tarball must not contain repository-only file: ${path}`,
  );
}

function assertPackedExport(target, exportName) {
  assert.equal(typeof target, "string", `${exportName} must resolve to a file path`);
  const path = target.replace(/^\.\//, "");
  assert.ok(packedFiles.has(path), `${exportName} target must exist in the npm tarball: ${path}`);
}

for (const [exportName, conditions] of Object.entries(packageJson.exports)) {
  if (typeof conditions === "string") {
    assertPackedExport(conditions, exportName);
    continue;
  }

  assertPackedExport(conditions.types, `${exportName} types`);
  assertPackedExport(conditions.import, `${exportName} import`);
  assert.equal(
    conditions.default,
    conditions.import,
    `${exportName} default and import conditions must resolve identically`,
  );
}

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

console.log(
  `Verified ${packedFiles.size} packed files and ${entrypoints.length} package entrypoints with Node.js.`,
);
