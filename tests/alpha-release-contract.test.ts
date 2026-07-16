import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

interface PackageManifest {
  name: string;
  version: string;
  type: string;
  files: string[];
  scripts: Record<string, string>;
  publishConfig: {
    access: string;
    provenance: boolean;
    tag?: string;
  };
}

interface ChangesetsConfig {
  changelog: [string, { repo: string }];
  access: string;
  baseBranch: string;
  ignore: string[];
}

interface PrereleaseState {
  mode: string;
  tag: string;
  initialVersions: Record<string, string>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
}

const packageJson = readJson<PackageManifest>("../package.json");
const changesetsConfig = readJson<ChangesetsConfig>("../.changeset/config.json");
const prereleaseState = readJson<PrereleaseState>("../.changeset/pre.json");
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const gitignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");

describe("alpha release contract", () => {
  it("uses a valid 0.x alpha SemVer for the public package", () => {
    expect(packageJson.name).toBe("@steventsao/agent-jsx");
    expect(packageJson.version).toMatch(/^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/);
  });

  it("keeps Changesets in alpha prerelease mode", () => {
    expect(prereleaseState.mode).toBe("pre");
    expect(prereleaseState.tag).toBe("alpha");
    expect(prereleaseState.initialVersions[packageJson.name]).toBeDefined();
    expect(changesetsConfig.access).toBe("public");
    expect(changesetsConfig.baseBranch).toBe("main");
    expect(changesetsConfig.ignore).not.toContain(packageJson.name);
    expect(changesetsConfig.changelog).toEqual([
      "@changesets/changelog-github",
      { repo: "steventsao/agent-jsx" },
    ]);
  });

  it("publishes only built ESM with public access and provenance", () => {
    expect(packageJson.type).toBe("module");
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.publishConfig).toEqual({
      access: "public",
      provenance: true,
    });
    expect(gitignore.split(/\r?\n/)).toContain("dist/");
  });

  it("validates the package before Changesets can publish it", () => {
    expect(packageJson.scripts.release).toBe("bun run package:check && changeset publish");
    expect(packageJson.scripts["package:check"]).toContain("node scripts/verify-package.mjs");
    expect(releaseWorkflow).toContain("needs: verify");
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/ci.yml");
    expect(ciWorkflow).toContain("run: bun run ci");
  });

  it("gates releases on every supported compatibility target", () => {
    const targets = [...ciWorkflow.matchAll(/^\s+- target: ([a-z0-9-]+)$/gm)]
      .map((match) => match[1])
      .sort();

    expect(targets).toEqual([
      "chess",
      "cloudflare",
      "document-review",
      "flue",
      "pdf-compiled",
      "pdf-target",
      "think",
    ]);
    expect(ciWorkflow).toContain("fail-fast: false");
  });

  it("uses the configured npm trusted publisher instead of a repository token", () => {
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("environment: npm");
    expect(releaseWorkflow).toContain("node-version: 24");
    expect(releaseWorkflow).toContain("npm install --global npm@11.18.0");
    expect(releaseWorkflow).not.toMatch(/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/);
  });

  it("versions main and creates GitHub releases through Changesets", () => {
    expect(packageJson.publishConfig.tag).toBeUndefined();
    expect(releaseWorkflow).toContain("branches:\n      - main");
    expect(releaseWorkflow).toContain("version: bun run version-packages");
    expect(releaseWorkflow).toContain("publish: bun run release");
    expect(releaseWorkflow).toContain("createGithubReleases: true");
  });
});
