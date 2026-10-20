# @krashidbuilt/actions

TypeScript-based reusable Gitea Actions for the krashidbuilt ecosystem.

## Consuming actions

Pin to the **floating major version tag** `@v1`:

```yaml
# Individual actions
- uses: krashidbuilt/actions/typescript/setup@v1

# Reusable workflows
jobs:
  verify:
    uses: krashidbuilt/actions/.github/workflows/reusable-typescript-verify.yml@v1
    with:
      working_directory: daemon
```

## The standard for CLI and library repos

Every repo here follows one of two shapes. Pick by whether the repo is a package
other things install.

**Published package** — `package.json` has `publishConfig.registry` pointing at
the Gitea registry and is not `private`. Gets `.gitea/workflows/publish.yml`:

```yaml
name: Publish
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  publish:
    uses: krashidbuilt/actions/.github/workflows/reusable-typescript-publish.yml@v1
    with:
      production_branch: main
      skip_build: true   # false if the package publishes a built dist/
      bun_version: "1.3.13"
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Merging to `main` then runs verify, computes the version from the conventional
commits since the last tag, tags it, and publishes. Nothing is pushed back to
the branch — the tags are the release history.

**Private or source-only** — `private: true`, run with `bun run src/index.ts`.
Gets `.gitea/workflows/verify.yml` calling `reusable-typescript-verify.yml@v1`
on push and pull_request. Same checks, no publish, no secret.

### Before wiring a repo up

- **Seed a tag matching `package.json`** (`git tag v0.1.0 && git push origin v0.1.0`).
  With no tags the versioning action reads the last 20 commits, and a single
  `!:` or `BREAKING CHANGE` in that window makes the first release `1.0.0`.
- **Check `has_actions`.** A repo can have Actions disabled, in which case the
  workflow sits on `main` and nothing ever runs, with no error anywhere —
  imessagecli was in that state. `curl -H "Authorization: token $T"
  $API/repos/$OWNER/$REPO | jq .has_actions`, and PATCH it to `true`.
- **`skip_build: true` unless the package publishes a build.** It governs the
  verify build as well, so a broken or vestigial binary-compile script does not
  fail CI for an artifact nobody ships.
- **Expect the first run to fail.** Turning CI on for the first time surfaces
  whatever was never checked — lint debt in bankcli and qbcli, a build script
  that had never worked in airbnbcli and sagacli.

Repos that are neither: printctl (Python) byte-compiles its scripts, slackcli
carries its upstream fork's own CI.

## Reusable Workflows

Pre-composed pipelines that consumer repos call with minimal configuration.

### reusable-typescript-verify.yml

Universal TypeScript verification. Runs setup → install → verify.

```yaml
jobs:
  verify:
    uses: krashidbuilt/actions/.github/workflows/reusable-typescript-verify.yml@v1
    with:
      working_directory: daemon       # Package directory
      run_tests: true                 # Run test script (default: false)
      run_build: true                 # Run build script (default: true)
      additional_install_directory: webview-ui  # Extra bun install (optional)
```

### reusable-deploy-frontend.yml

Full deploy pipeline: setup → install → optional verify → version → deploy to S3/CloudFront.

```yaml
jobs:
  deploy:
    uses: krashidbuilt/actions/.github/workflows/reusable-deploy-frontend.yml@v1
    secrets: inherit
    with:
      working_directory: web
      app_name: ctrl
```

Permissions (`contents: write`) are declared inside the reusable workflow — callers don't need them. AWS auth uses long-lived access keys passed in via `secrets.AWS_ACCESS_KEY_ID` / `secrets.AWS_SECRET_ACCESS_KEY` (set at the org level). Environment and prerelease identifier are auto-detected from the branch.

### reusable-deploy-mobile.yml

Expo/EAS build + optional store submit + optional version bump. Parameter-driven: the CALLER maps
branches to behaviour (no branch names inside). Boolean-ish inputs take `'true'`/`'false'` strings.
Defaults are safe: `preview` profile, iOS only, no submit, no release.

```yaml
jobs:
  deploy:
    uses: krashidbuilt/actions/.github/workflows/reusable-deploy-mobile.yml@v1
    secrets:
      EXPO_TOKEN: ${{ secrets.EXPO_TOKEN }}   # PUSH_TOKEN too, if the default branch is protected
    with:
      profile: ${{ github.ref_name == 'production' && 'production' || 'preview' }}
      platforms: all                 # ios | android | all | none
      auto_submit: ${{ github.ref_name == 'production' && 'true' || 'false' }}
      create_release: ${{ github.ref_name == 'production' && 'true' || 'false' }}
      version_sync_command: "npm pkg set version=$VERSION && node sync.app.version.js"
```

- **Versioning only:** `platforms: none` (or `run_build: 'false'`) with `create_release: 'true'`
  tags, writes the version into the files via `version_sync_command` (which receives `VERSION`), and
  commits `chore(release): vX.Y.Z [skip ci]`. Use it on the integration branch; build from the
  promotion branches with `create_release: 'false'`. A matrix over several apps/profiles works too
  (`profile: ${{ matrix.app }}-${{ github.ref_name }}`), with `run_verify: 'false'` and a verify job
  of your own so the suite runs once.
- **Apple capabilities are never synced from CI** (`EXPO_NO_CAPABILITY_SYNC=1` on every build).
  Enable App Groups, push and the like by hand in the Apple portal during the one-time interactive
  `eas credentials -p ios`; non-interactive builds only sign. `refresh_ad_hoc_profile` is unaffected.
- The version bump commit is pushed with `github.token` (or `secrets.PUSH_TOKEN`); on GitHub the
  repo's workflow permissions must be read/write and the branch must allow that push.
- **Pass secrets by name from another organization.** `secrets: inherit` only reaches a reusable in
  the same org or enterprise; a cross-org caller (e.g. fifth-gear-tech calling the public GitHub
  mirror) must pass `EXPO_TOKEN` (and `PUSH_TOKEN`) explicitly or eas-cli sees an empty token.
  Same-org callers can keep `inherit`.
- **Build on your own Mac with no build credit:** `build_runner: local` runs `eas build --local` (same
  pipeline, EAS-managed credentials) on a self-hosted macOS runner, waits, and with `auto_submit`
  uploads the artifact via `eas submit --path` (submissions are free). Default `eas` = EAS cloud, as
  before. Both platforms build on the macOS host (Android build-tools have no linux-arm64 binaries).
  Pick the runner with `local_runner_label`: on GitHub, a self-hosted runner registered to the
  calling repo (`fifth-gear-studio` for fifth-gear-tech-native-app); on Gitea, the default
  `studio-host`, plus `runs-on: studio-host` on the calling job. Host setup (Xcode, CocoaPods,
  fastlane, JDK 17, Android SDK + NDK) is in hestia `studio/services/github-runner-fifth-gear/`.

  ```yaml
      with:
        profile: ${{ matrix.app }}-staging
        platforms: all
        auto_submit: "true"
        build_runner: local
        local_runner_label: fifth-gear-studio
  ```

### reusable-typescript-publish.yml

Build → version → publish to npm via OIDC trusted publishing (no npm token needed for the publish step itself). `NPM_TOKEN` is only used during `bun install` to authenticate private `@krashidbuilt` packages.

```yaml
jobs:
  publish:
    uses: krashidbuilt/actions/.github/workflows/reusable-typescript-publish.yml@v1
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}  # for install only — publish uses OIDC
    with:
      working_directory: packages/my-lib
```

npm dist-tag is auto-mapped: develop → `alpha`, staging → `beta`, production → `latest`.

## Release Flow (this repo)

This repo follows a **floating major version tag** pattern (same as `actions/checkout`, `actions/setup-node`, etc.):

1. Feature branch → PR to `develop` → self-verify CI runs
2. Merge to `develop` (alpha channel)
3. Promote `develop` → `staging` → `production`
4. Tag `v1.x.x` on production
5. `release.yml` triggers → force-updates `v1` to point at `v1.x.x`
6. All consumers referencing `@v1` pick up the new code

Breaking changes require a major version bump (`v2.0.0`) — consumers stay on `@v1` until they opt in.

## Architecture

Actions are written in TypeScript with shared core utilities, bundled with esbuild to single-file `dist/index.js`, and `action.yml` files are auto-generated from `config.ts` definitions.

```
src/core/           # Shared utilities (env, logging, AWS, git, versioning)
src/actions/        # Action source (config.ts + index.ts + logic.ts)
deploy/             # Generated output for deploy actions (action.yml + dist/index.js) — committed
typescript/         # Generated output for typescript actions
utilities/          # Generated output for utility actions
versioning/         # Generated output for versioning action
scripts/            # Build tooling (bundle, generate, verify)
```

(Generated outputs live at the repo root by category; consumers reference them as `krashidbuilt/actions/<category>/<action>@v1`.)

## Development

```bash
bun install                # Install dependencies
bun run bundle             # Build + bundle + generate action.yml files
bun run verify             # Lint + typecheck + test + verify bundles
bun run lint               # Biome check
bun run typecheck          # tsc --noEmit
bun run test               # Vitest
```

## Available Actions

### Versioning

```yaml
- uses: krashidbuilt/actions/versioning@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prerelease_identifier: alpha  # or beta
```

### TypeScript

```yaml
# Setup Node.js + Bun
- uses: krashidbuilt/actions/typescript/setup@v1

# Install dependencies
- uses: krashidbuilt/actions/typescript/install-dependencies@v1

# Run verify (tsc + biome)
- uses: krashidbuilt/actions/typescript/verify@v1
  with:
    working_directory: daemon

# Publish to npm (uses OIDC trusted publishing — requires id-token: write)
- uses: krashidbuilt/actions/typescript/publish@v1
  with:
    tag: alpha
```

### Deploy

```yaml
# Frontend (S3 + CloudFront)
- uses: krashidbuilt/actions/deploy/frontend@v1
  with:
    working_directory: web

# Deploy specific version from artifact bucket
- uses: krashidbuilt/actions/deploy/frontend-artifact@v1
  with:
    environment: production
    version: 1.0.0
    app_name: ctrl

# Invalidate CloudFront cache
- uses: krashidbuilt/actions/deploy/invalidate-cache@v1
  with:
    environment: production
    app_name: ctrl

# Rollback to previous version
- uses: krashidbuilt/actions/deploy/rollback-frontend@v1
  with:
    environment: production
    app_name: ctrl

# Build standalone binary
- uses: krashidbuilt/actions/deploy/build-binary@v1
  with:
    entry: daemon/src/index.ts
    target: bun-darwin-arm64
    outfile: ctrl-daemon-darwin-arm64
```

### Utilities

```yaml
# Configure AWS credentials for environment
- uses: krashidbuilt/actions/utilities/configure-aws@v1
  with:
    environment: alpha

# Detect environment from branch
- uses: krashidbuilt/actions/utilities/detect-environment@v1

# Detect app info from package.json
- uses: krashidbuilt/actions/utilities/detect-app-info@v1

# Commit bundled artifacts
- uses: krashidbuilt/actions/utilities/commit-artifacts@v1
  with:
    paths: deploy typescript utilities versioning

# Parse semver version
- uses: krashidbuilt/actions/utilities/parse-version@v1
  with:
    version: 1.2.3-alpha.1

# Update major version tags (v1 -> latest v1.x.x)
- uses: krashidbuilt/actions/utilities/update-version-tags@v1
  with:
    version: 1.2.3

# Sync branches (back-merge)
- uses: krashidbuilt/actions/utilities/sync-branches@v1
  with:
    source: production
    target: develop

# Merge branch
- uses: krashidbuilt/actions/utilities/merge-branch@v1
  with:
    branch: develop

# Trigger workflow dispatch
- uses: krashidbuilt/actions/utilities/trigger-workflow@v1
  with:
    workflow: release.yml
    branch: main
```
