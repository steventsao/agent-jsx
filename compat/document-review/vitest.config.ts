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
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
