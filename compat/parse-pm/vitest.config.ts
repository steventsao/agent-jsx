// Mirrors compat/pdf-compiled + the cloudflare-agents repo's own test config
// (the known-good vitest-pool-workers setup): the `agents/vite` plugin plus
// the `cloudflareTest` plugin pointed at wrangler.jsonc. Runs the ParsePmAgent
// inside real workerd — no mocks of `agents`, no dev server. Tests use the
// FAKE provider (PARSE_PM_FAKE_PROVIDER var in wrangler.jsonc); the live
// OpenRouter path never executes here.
import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

const here = import.meta.dirname;

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: path.join(here, "wrangler.jsonc") },
    }),
  ],
  test: {
    include: [path.join(here, "test/**/*.spec.ts")],
    // unpdf parses the 378KB ParseBench page inside workerd — generous
    // timeouts, as in compat/pdf-compiled.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
