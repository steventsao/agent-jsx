// Mirrors the cloudflare-agents-playground test config (the known-good
// vitest-pool-workers setup for agents 0.8.5): the `agents/vite` plugin plus
// the `cloudflareTest` plugin pointed at wrangler.jsonc. Runs the generated
// classes inside real workerd — no dev server, no mocks.
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
    testTimeout: 30000, // pdf.js parse of a 378KB page inside workerd
    hookTimeout: 30000,
  },
});
