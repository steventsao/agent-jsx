# Agent guide

This file is the repository-level source of truth for automated contributors. More specific `AGENTS.md` files may add rules for their subtree.

## Toolchain

- Use Bun `1.3.2`, as pinned by `packageManager` in `package.json`.
- Install root dependencies with `bun install --frozen-lockfile`.
- Keep the repository ESM-only. Published JavaScript belongs in `dist/`; source remains TypeScript.
- Do not commit `dist/`. CI builds and validates the exact npm tarball before release.

## Verification

Run the smallest relevant check while iterating, then run the full package gate before handing off a package-facing change:

```sh
bun run typecheck
bun run test
bun run package:check
```

`bun run ci` runs all three. `package:check` builds JavaScript and declarations, runs publint and Are the Types Wrong, packs the package, and imports every public entrypoint with Node.js.

The compatibility suites are the integration source of truth. If a change touches an emitter or target contract, run the affected suite under `compat/<target>`. CI runs chess, Cloudflare Agents, document review, Flue, both PDF targets, and Cloudflare Think independently.

## Semver and changesets

The public package is `@steventsao/agent-jsx`. It is in alpha prerelease mode and follows SemVer:

- Patch: backward-compatible bug fix.
- Minor: backward-compatible feature. While the package is `0.x`, use a minor bump for a breaking API change.
- Major: stable-era breaking change; do not use this during the alpha line without maintainer direction.

Every pull request with a user-visible package change must add a changeset with `bun run changeset`. Choose `@steventsao/agent-jsx`, select the impact, and write a concise changelog sentence. Tests, examples, documentation, and CI-only changes do not require one. See [.changeset/README.md](.changeset/README.md) for the contributor-facing summary.

Never edit the package version or `CHANGELOG.md` by hand. The Changesets release workflow owns both. While `.changeset/pre.json` is in `alpha` mode, release pull requests produce versions such as `0.1.0-alpha.0` and `0.1.0-alpha.1`, and publish them to npm's `alpha` dist-tag. Because the package has not had a normal release yet, npm also retains `latest` on the newest alpha; the first stable release will take ownership of `latest`.

## Release flow

1. Merge ordinary pull requests with their changesets into `main`.
2. The `Release` workflow updates one `chore: version packages` pull request.
3. Review that pull request's version and changelog, then merge it when the release is ready.
4. The next `Release` run rebuilds and validates the tarball, publishes it to npm, pushes the package tag, and creates the GitHub release.

To promote the project out of alpha, make a dedicated pull request that runs `bun run changeset pre exit`; do not delete or edit `pre.json` manually.

The package's npm trusted publisher is configured as:

- GitHub owner: `steventsao`
- Repository: `agent-jsx`
- Workflow: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Do not add an `NPM_TOKEN` publish secret. The workflow uses GitHub OIDC and npm provenance automatically.
