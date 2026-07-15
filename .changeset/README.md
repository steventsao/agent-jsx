# Changesets

Every pull request that changes the published package must include a changeset:

```sh
bun run changeset
```

Choose `@steventsao/agent-jsx`, select the semver impact, and describe the user-visible change. Documentation, tests, examples, and CI-only changes do not need a changeset.

The repository is currently in Changesets prerelease mode. Version pull requests therefore produce `0.x.y-alpha.N` versions and publish them under npm's `alpha` dist-tag.
