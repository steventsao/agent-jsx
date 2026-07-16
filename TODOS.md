# TODOS

## Release operations

### Verify npm trusted publishing

**What:** Verify the next alpha publishes through GitHub OIDC with npm provenance and no repository publish token.

**Why:** The trusted-publisher relationship is configured, but only a later unpublished version can prove the complete OIDC publication path.

**Context:** npm trusts owner `steventsao`, repository `agent-jsx`, workflow `release.yml`, environment `npm`, and the `npm publish` action. The bootstrap secret has been deleted. Publish the next real alpha through the normal Changesets flow and confirm the npm version includes provenance.

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
