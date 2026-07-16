# TODOS

## Release operations

### Bootstrap the first npm release

**What:** Add a fresh granular `NPM_TOKEN` repository secret with publish access and 2FA bypass, then merge the first automated `chore: version packages` pull request.

**Why:** npm trusted publishing cannot be configured until `@steventsao/agent-jsx` exists, so `0.1.0-alpha.0` needs a one-time token-backed publication.

**Context:** Merge the SemVer/release-pipeline pull request first. The `Release` workflow will open the version pull request rather than publish immediately. Add the token before merging that version pull request, then verify the workflow publishes `@steventsao/agent-jsx@0.1.0-alpha.0` to the `alpha` dist-tag and creates the matching Git tag and GitHub release.

**Effort:** S
**Priority:** P0
**Depends on:** Merge of the SemVer/release-pipeline pull request

### Migrate npm publication to trusted publishing

**What:** Configure npm trusted publishing for `.github/workflows/release.yml` in the `npm` environment, verify an OIDC/provenance release, and delete the `NPM_TOKEN` repository secret.

**Why:** OIDC removes the long-lived publishing credential while preserving automated releases and npm provenance.

**Context:** In npm, configure owner `steventsao`, repository `agent-jsx`, workflow `release.yml`, and environment `npm`. Publish a later alpha through the normal Changesets flow, confirm trusted publishing succeeds, then remove the bootstrap token from GitHub.

**Effort:** S
**Priority:** P1
**Depends on:** Bootstrap the first npm release

## Completed

