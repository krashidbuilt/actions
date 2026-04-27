# @krashidbuilt/actions

TypeScript-based reusable Gitea Actions for the krashidbuilt ecosystem.

## Consuming actions

Pin to the **floating major version tag** `@v1`:

```yaml
# Individual actions
- uses: krashidbuilt/actions/actions/typescript/setup@v1

# Reusable workflows
jobs:
  verify:
    uses: krashidbuilt/actions/.gitea/workflows/reusable-typescript-verify.yml@v1
    with:
      working_directory: daemon
```

## Reusable Workflows

Pre-composed pipelines that consumer repos call with minimal configuration.

### reusable-typescript-verify.yml

Universal TypeScript verification. Runs setup → install → verify.

```yaml
jobs:
  verify:
    uses: krashidbuilt/actions/.gitea/workflows/reusable-typescript-verify.yml@v1
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
    uses: krashidbuilt/actions/.gitea/workflows/reusable-deploy-frontend.yml@v1
    secrets: inherit
    with:
      working_directory: web
      app_name: ctrl
```

Permissions (`contents: write`) are declared inside the reusable workflow — callers don't need them. AWS auth uses long-lived access keys passed in via `secrets.AWS_ACCESS_KEY_ID` / `secrets.AWS_SECRET_ACCESS_KEY` (set at the org level). Environment and prerelease identifier are auto-detected from the branch.

### reusable-typescript-publish.yml

Build → version → publish to npm via OIDC trusted publishing (no npm token needed for the publish step itself). `NPM_TOKEN` is only used during `bun install` to authenticate private `@krashidbuilt` packages.

```yaml
jobs:
  publish:
    uses: krashidbuilt/actions/.gitea/workflows/reusable-typescript-publish.yml@v1
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
actions/            # Generated output (action.yml + dist/index.js) — committed
scripts/            # Build tooling (bundle, generate, verify)
```

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
- uses: krashidbuilt/actions/actions/versioning@v1
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prerelease_identifier: alpha  # or beta
```

### TypeScript

```yaml
# Setup Node.js + Bun
- uses: krashidbuilt/actions/actions/typescript/setup@v1

# Install dependencies
- uses: krashidbuilt/actions/actions/typescript/install-dependencies@v1

# Run verify (tsc + biome)
- uses: krashidbuilt/actions/actions/typescript/verify@v1
  with:
    working_directory: daemon

# Publish to npm (uses OIDC trusted publishing — requires id-token: write)
- uses: krashidbuilt/actions/actions/typescript/publish@v1
  with:
    tag: alpha
```

### Deploy

```yaml
# Frontend (S3 + CloudFront)
- uses: krashidbuilt/actions/actions/deploy/frontend@v1
  with:
    working_directory: web

# Deploy specific version from artifact bucket
- uses: krashidbuilt/actions/actions/deploy/frontend-artifact@v1
  with:
    environment: production
    version: 1.0.0
    app_name: ctrl

# Invalidate CloudFront cache
- uses: krashidbuilt/actions/actions/deploy/invalidate-cache@v1
  with:
    environment: production
    app_name: ctrl

# Rollback to previous version
- uses: krashidbuilt/actions/actions/deploy/rollback-frontend@v1
  with:
    environment: production
    app_name: ctrl

# Build standalone binary
- uses: krashidbuilt/actions/actions/deploy/build-binary@v1
  with:
    entry: daemon/src/index.ts
    target: bun-darwin-arm64
    outfile: ctrl-daemon-darwin-arm64
```

### Utilities

```yaml
# Configure AWS credentials for environment
- uses: krashidbuilt/actions/actions/utilities/configure-aws@v1
  with:
    environment: alpha

# Detect environment from branch
- uses: krashidbuilt/actions/actions/utilities/detect-environment@v1

# Detect app info from package.json
- uses: krashidbuilt/actions/actions/utilities/detect-app-info@v1

# Commit bundled artifacts
- uses: krashidbuilt/actions/actions/utilities/commit-artifacts@v1
  with:
    paths: actions/

# Parse semver version
- uses: krashidbuilt/actions/actions/utilities/parse-version@v1
  with:
    version: 1.2.3-alpha.1

# Update major version tags (v1 -> latest v1.x.x)
- uses: krashidbuilt/actions/actions/utilities/update-version-tags@v1
  with:
    version: 1.2.3

# Sync branches (back-merge)
- uses: krashidbuilt/actions/actions/utilities/sync-branches@v1
  with:
    source: production
    target: develop

# Merge branch
- uses: krashidbuilt/actions/actions/utilities/merge-branch@v1
  with:
    branch: develop

# Trigger workflow dispatch
- uses: krashidbuilt/actions/actions/utilities/trigger-workflow@v1
  with:
    workflow: release.yml
    branch: main
```
