# Contributing

Thanks for helping improve agent-jsx. The project uses Bun and keeps package changes behind the same checks that run in GitHub Actions.

## Development

```sh
bun install --frozen-lockfile
bun run ci
```

Target adapters have integration suites in `compat/`. Run the affected suite when changing compiler output or a target contract; for example:

```sh
cd compat/think
bun install --frozen-lockfile
bun run typecheck
bun run test
```

## Package changes

If a pull request changes behavior exposed by `@steventsao/agent-jsx`, add a release note before opening the pull request:

```sh
bun run changeset
```

Use a patch for a compatible fix and a minor for a feature. During the `0.x` alpha period, breaking changes also use a minor bump and must call out the break in the changeset. Documentation, tests, examples, and CI-only changes do not need a changeset.

Do not edit versions, changelogs, tags, or npm dist-tags manually. The release workflow turns merged changesets into a version pull request; merging that pull request publishes the package and creates its GitHub release.
