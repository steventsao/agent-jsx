import { defineConfig } from "vitest/config";

// node environment on purpose: unpdf's pdf.js build (fake-worker
// requestImportModule + structuredClone paths) is incompatible with `bun
// test` but first-class on node and workerd — the actual runtime targets.
export default defineConfig({
  test: { environment: "node", pool: "forks", include: ["test/**/*.test.ts"] },
});
