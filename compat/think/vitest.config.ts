// Runs the generated THINK-mode classes inside real workerd (vitest-pool-workers)
// against real @cloudflare/think@0.12.1 + agents@0.17.3 — no dev server, no mocks
// for the framework (only getModel is a test-supplied mock where a turn is driven).
// Mirrors the cloudflare-agents-playground think test config (cloudflareTest +
// a warmup setup file); the agents/vite plugin renders our react-free components.
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

const testsDir = import.meta.dirname;

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: path.join(testsDir, "wrangler.jsonc") },
    }),
  ],
  test: {
    include: [path.join(testsDir, "test/**/*.spec.ts")],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
