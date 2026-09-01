# TODOS

## Release operations

### Bootstrap the `@agent-jsx` npm scope

**What:** Publish `@agent-jsx/core` once, configure its npm trusted publisher,
then verify the next alpha publishes through GitHub OIDC with provenance and no
repository publish token.

**Why:** Trusted publishing is configured per npm package. The existing
relationship belongs to the superseded `@steventsao/agent-jsx` identity and
does not transfer with the scope rename.

**Context:** Keep owner `steventsao`, repository `agent-jsx`, workflow
`release.yml`, environment `npm`, and the `npm publish` action. Bootstrap the
new public package without adding an `NPM_TOKEN`, configure its trusted
publisher, then use the normal Changesets flow and confirm provenance.

**Effort:** S
**Priority:** P1
**Depends on:** A user-visible change with a new changeset

## Completed

### Bootstrap the first npm release

**What:** Publish `@steventsao/agent-jsx@0.1.0-alpha.0`, create the matching Git tag and GitHub prerelease, configure npm trusted publishing, and remove the bootstrap token.

**Why:** The package had to exist before npm could accept its trusted-publisher configuration.

**Context:** The first alpha was published with npm's browser-authorized CLI flow. Trusted publishing now targets `steventsao/agent-jsx`, `release.yml`, and the `npm` environment.

**Effort:** S
**Priority:** P0
**Depends on:** Merge of the SemVer/release-pipeline pull request

**Completed:** v0.1.0-alpha.0 (2026-07-16)
