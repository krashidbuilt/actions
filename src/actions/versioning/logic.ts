/**
 * Versioning Action - Business Logic
 *
 * Handles version bumping, git tagging, and GitHub release creation.
 * This is decoupled from deployment to allow independent versioning workflows.
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import {
  bumpVersion,
  common,
  configureGitIdentity,
  DEFAULT_TAG_PREFIX,
  determineBumpTypeFromCommits,
  getLatestGitTag,
  getLatestPrereleaseTagForVersion,
  git,
  Logger,
  parseVersion,
  readProjectVersion,
  stripTagPrefix,
  tagExists,
  type VersionBumpType,
} from "../../core/index.js";

const logger = new Logger({ prefix: "versioning" });

export interface VersioningInputs {
  bumpType: "auto" | VersionBumpType;
  workingDirectory: string;
  createTag: boolean;
  createRelease: boolean;
  releaseDraft: boolean;
  releasePrerelease: boolean;
  prereleaseIdentifier: string;
  generateChangelog: boolean;
  updateVersionFile: boolean;
  pushChanges: boolean;
  githubToken: string;
  gitUserName: string;
  gitUserEmail: string;
  dryRun: boolean;
  promoteFrom: string;
  /** Prefix of the version tags read and written (default `v`). */
  tagPrefix: string;
  /** True when promote_from is set but prerelease_identifier is empty (promote to stable release). */
  promoteToStable: boolean;
  /**
   * An exact version to release instead of computing one. The publish workflow computes the
   * number once, publishes it, then passes it here so the tag and release record that number.
   */
  version: string;
}

/** Characters allowed in a tag prefix: a safe subset of what git accepts in a ref name. */
const TAG_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** An explicit `version` input: MAJOR.MINOR.PATCH with an optional prerelease, no prefix. */
const EXPLICIT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function getInputs(): VersioningInputs {
  const dryRun = core.getInput("dry_run") === "true";
  const token = core.getInput("github_token");
  if (!token && !dryRun) {
    throw new Error("github_token is required (unless dry_run is true)");
  }

  const tagPrefix = core.getInput("tag_prefix") || DEFAULT_TAG_PREFIX;
  if (!TAG_PREFIX_PATTERN.test(tagPrefix)) {
    throw new Error(
      `Invalid tag_prefix "${tagPrefix}": use letters, digits, '.', '_', '/' or '-', starting with a letter or digit`,
    );
  }

  const version = core.getInput("version").trim();
  if (version && !EXPLICIT_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version "${version}": expected MAJOR.MINOR.PATCH[-prerelease], without a tag prefix`);
  }
  const promoteFrom = core.getInput("promote_from") || "";
  if (version && promoteFrom) {
    throw new Error("version and promote_from cannot both be set");
  }

  return {
    bumpType: (core.getInput("bump_type") || "auto") as "auto" | VersionBumpType,
    workingDirectory: common.workingDirectory(),
    createTag: core.getInput("create_tag") !== "false",
    createRelease: core.getInput("create_release") !== "false",
    releaseDraft: core.getInput("release_draft") === "true",
    releasePrerelease: core.getInput("release_prerelease") === "true",
    prereleaseIdentifier: core.getInput("prerelease_identifier") || "alpha",
    generateChangelog: core.getInput("generate_changelog") !== "false",
    updateVersionFile: core.getInput("update_version_file") !== "false",
    pushChanges: core.getInput("push_changes") !== "false",
    githubToken: token,
    gitUserName: git.userName(),
    gitUserEmail: git.userEmail(),
    dryRun,
    promoteFrom,
    tagPrefix,
    promoteToStable: !core.getInput("prerelease_identifier") && !!promoteFrom,
    version,
  };
}

/**
 * Compare two semantic versions.
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
  const parsed1 = parseVersion(v1);
  const parsed2 = parseVersion(v2);

  if (parsed1.major !== parsed2.major) return parsed1.major - parsed2.major;
  if (parsed1.minor !== parsed2.minor) return parsed1.minor - parsed2.minor;
  if (parsed1.patch !== parsed2.patch) return parsed1.patch - parsed2.patch;

  if (parsed1.prerelease && !parsed2.prerelease) return -1;
  if (!parsed1.prerelease && parsed2.prerelease) return 1;

  return 0;
}

/**
 * Run a `git log` and return its stdout. With `scopeDir`, git runs in that directory
 * with a `-- .` pathspec, so only commits touching it are listed.
 */
async function readGitLog(args: string[], scopeDir?: string): Promise<string> {
  let commitLog = "";

  await exec.exec("git", scopeDir ? [...args, "--", "."] : args, {
    listeners: {
      stdout: (data) => {
        commitLog += data.toString();
      },
    },
    silent: true,
    ...(scopeDir ? { cwd: scopeDir } : {}),
  });

  return commitLog;
}

/**
 * The directory the commit range is scoped to: the working directory when the tag
 * prefix is non-default (one of several packages in a repo), otherwise none, so
 * `v`-tagged repos keep counting every commit.
 */
export function commitScope(inputs: Pick<VersioningInputs, "tagPrefix">, workingDir: string): string | undefined {
  return inputs.tagPrefix === DEFAULT_TAG_PREFIX ? undefined : workingDir;
}

/**
 * Get commits since last tag and determine bump type.
 * With `scopeDir`, only commits touching that directory count.
 */
export async function determineBumpType(
  latestTag: string | null,
  scopeDir?: string,
): Promise<VersionBumpType | "none"> {
  const args = latestTag ? ["log", `${latestTag}..HEAD`, "--oneline"] : ["log", "--oneline", "-20"];
  const commitLog = await readGitLog(args, scopeDir);

  const commits = commitLog
    .trim()
    .split("\n")
    .filter((c) => c.length > 0);

  return determineBumpTypeFromCommits(commits);
}

/**
 * Generate changelog from commits.
 * With `scopeDir`, only commits touching that directory are listed.
 */
export async function generateChangelog(latestTag: string | null, scopeDir?: string): Promise<string> {
  const args = latestTag
    ? ["log", `${latestTag}..HEAD`, "--pretty=format:- %s (%h)"]
    : ["log", "--pretty=format:- %s (%h)", "-20"];
  const commitLog = await readGitLog(args, scopeDir);

  return commitLog.trim() || "No changes recorded.";
}

/**
 * Update version in package.json using npm version (no git operations).
 * Git commit and tag are handled separately for reliability in monorepo subdirectories.
 * `--allow-same-version`: in the publish workflow, publish has already written this version
 * into package.json, and npm otherwise fails with "Version not changed".
 */
export async function updateVersionFile(workingDir: string, newVersion: string): Promise<void> {
  await exec.exec("npm", ["version", newVersion, "--no-git-tag-version", "--allow-same-version", "--force"], {
    cwd: workingDir,
  });
  logger.info(`Updated package.json to ${newVersion}`);
}

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);

    if (inputs.dryRun) {
      logger.info("[DRY RUN] Starting version bump analysis", { workingDirectory: workingDir });
    } else {
      logger.info("Starting version bump", { workingDirectory: workingDir });
    }

    // Configure git (needed for tag detection even in dry run)
    await configureGitIdentity(inputs.gitUserName, inputs.gitUserEmail, { silent: false });

    // Tag-driven versioning: prefer latest stable tag, fall back to package.json for bootstrap.
    // With an explicit version, package.json is not read at all: by the time the publish
    // workflow records its release, publish has already written the new version into the
    // working tree's package.json, and bumping from that again tagged krashidbuilt/http's
    // first release v0.2.0 over a published 0.1.0.
    const latestStableTag = await getLatestGitTag(true, inputs.tagPrefix);
    const packageVersion = latestStableTag
      ? stripTagPrefix(latestStableTag, inputs.tagPrefix)
      : inputs.version
        ? ""
        : readProjectVersion(workingDir);

    logger.info("Current state", {
      packageVersion,
      latestStableTag,
      tagPrefix: inputs.tagPrefix,
      versionSource: latestStableTag
        ? "git tag"
        : inputs.version
          ? "none (explicit version)"
          : "package.json (bootstrap)",
      isPrerelease: inputs.releasePrerelease,
    });

    // Promotion code path: replace or strip a prerelease identifier without a conventional-commits bump
    if (inputs.promoteFrom) {
      const currentVersion = readProjectVersion(workingDir);
      let promotedVersion: string;

      if (inputs.promoteToStable) {
        // Strip the prerelease suffix entirely (promote to stable)
        // e.g. "0.3.0-beta.2" → "0.3.0"
        promotedVersion = currentVersion.replace(new RegExp(`-${inputs.promoteFrom}(\\.\\d+)?$`), "");
      } else {
        // Replace promoteFrom identifier with prereleaseIdentifier
        // e.g. "0.3.0-alpha.2" with promoteFrom="alpha", prereleaseIdentifier="beta" → "0.3.0-beta.2"
        promotedVersion = currentVersion.replace(
          new RegExp(`-${inputs.promoteFrom}(\\.(\\d+))?$`),
          `-${inputs.prereleaseIdentifier}$1`,
        );
      }

      logger.info(`Promotion: ${currentVersion} -> ${promotedVersion}`, {
        promoteFrom: inputs.promoteFrom,
        target: inputs.promoteToStable ? "(stable)" : inputs.prereleaseIdentifier,
      });

      const tag = `${inputs.tagPrefix}${promotedVersion}`;
      const isPrerelease = promotedVersion.includes("-");

      let changelog = "";
      if (inputs.generateChangelog) {
        changelog = await generateChangelog(latestStableTag, commitScope(inputs, workingDir));
        logger.info("Generated changelog", { referenceTag: latestStableTag });
      }

      core.setOutput("previous_version", currentVersion);
      core.setOutput("version", promotedVersion);
      core.setOutput("bump_type", "promote");
      core.setOutput("tag", tag);
      core.setOutput("is_prerelease", String(isPrerelease));

      if (inputs.dryRun) {
        logger.info("[DRY RUN] Would perform promotion:");
        logger.info(`  - Version: ${currentVersion} -> ${promotedVersion}`);
        logger.info(`  - Tag: ${tag}`);
        logger.info(`  - Is prerelease: ${isPrerelease}`);
        core.info(`[DRY RUN] Promotion analysis complete: ${tag}`);
        return;
      }

      if (inputs.updateVersionFile) {
        await updateVersionFile(workingDir, promotedVersion);
        await exec.exec("git", ["add", "-A"], { cwd: workingDir });
        await exec.exec("git", ["commit", "-m", `chore(release): ${tag}`]);
        logger.info(`Committed promoted version to ${promotedVersion}`);
      }

      if (inputs.createTag) {
        const tagAlreadyExists = await tagExists(tag);
        if (tagAlreadyExists) {
          logger.warn(`Tag ${tag} already exists, skipping tag creation`);
        } else {
          await exec.exec("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
          logger.info(`Created tag ${tag}`);
        }
      }

      if (inputs.pushChanges) {
        // Only push HEAD when updateVersionFile actually committed something —
        // pushing a tag does NOT require pushing HEAD, and doing so unconditionally
        // races with other concurrent jobs / commits and fails non-fast-forward.
        if (inputs.updateVersionFile) {
          await exec.exec("git", ["push", "--set-upstream", "origin", "HEAD"]);
        }
        if (inputs.createTag) {
          await exec.exec("git", ["push", "origin", tag]);
        }
        if (inputs.updateVersionFile || inputs.createTag) {
          logger.info("Pushed changes and tag");
        }
      }

      if (inputs.createRelease) {
        const octokit = github.getOctokit(inputs.githubToken);
        const { owner, repo } = github.context.repo;

        let release: { data: { html_url: string } };
        try {
          const existingRelease = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
          release = await octokit.rest.repos.updateRelease({
            owner,
            repo,
            release_id: existingRelease.data.id,
            name: isPrerelease ? `${tag} (Pre-release)` : tag,
            body: changelog,
            draft: inputs.releaseDraft,
            prerelease: isPrerelease,
          });
          logger.info("Updated existing GitHub release", { url: release.data.html_url });
        } catch (error: unknown) {
          const isNotFound =
            error instanceof Object && "status" in error && (error as { status: number }).status === 404;
          if (isNotFound) {
            release = await octokit.rest.repos.createRelease({
              owner,
              repo,
              tag_name: tag,
              name: isPrerelease ? `${tag} (Pre-release)` : tag,
              body: changelog,
              draft: inputs.releaseDraft,
              prerelease: isPrerelease,
            });
            logger.info("Created GitHub release", { url: release.data.html_url });
          } else {
            throw error;
          }
        }

        core.setOutput("release_url", release.data.html_url);
      }

      logger.info(`Promotion complete: ${tag}`);
      return;
    }

    let newVersion = "";

    // Determine bump type once (used by both prerelease and stable paths)
    let bumpType: VersionBumpType | "none" | "explicit";
    if (inputs.version) {
      newVersion = inputs.version;
      bumpType = "explicit";
      logger.info(`Using the given version: ${newVersion} (nothing computed)`);
    } else if (inputs.bumpType === "auto") {
      bumpType = await determineBumpType(latestStableTag, commitScope(inputs, workingDir));
      logger.info(`Auto-detected bump type: ${bumpType}`, { referenceTag: latestStableTag });
    } else {
      bumpType = inputs.bumpType;
    }

    if (bumpType === "explicit") {
      // newVersion is already set
    } else if (inputs.releasePrerelease) {
      // Prerelease: derive next stable base from tag + bump, then increment prerelease counter
      const effectiveBump = bumpType === "none" ? "patch" : bumpType;
      const nextStableBase = bumpVersion(packageVersion, effectiveBump);

      logger.info(`Prerelease base: ${packageVersion} + ${effectiveBump} -> ${nextStableBase}`);

      const latestPrereleaseTag = await getLatestPrereleaseTagForVersion(
        nextStableBase,
        inputs.prereleaseIdentifier,
        inputs.tagPrefix,
      );

      let nextPrereleaseNum: number;
      if (latestPrereleaseTag) {
        const parsed = parseVersion(latestPrereleaseTag, inputs.tagPrefix);
        const prereleaseMatch = parsed.prerelease?.match(new RegExp(`^${inputs.prereleaseIdentifier}\\.(\\d+)$`));
        nextPrereleaseNum = prereleaseMatch ? Number.parseInt(prereleaseMatch[1], 10) + 1 : 1;
        logger.info(
          `Found latest prerelease tag: ${latestPrereleaseTag}, starting from ${inputs.prereleaseIdentifier}.${nextPrereleaseNum}`,
        );
      } else {
        nextPrereleaseNum = 1;
        logger.info(
          `No existing ${inputs.prereleaseIdentifier} tags for ${nextStableBase}, starting from ${inputs.prereleaseIdentifier}.1`,
        );
      }

      // Find the next available version (handles race conditions and stale tags)
      const maxAttempts = 10;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        newVersion = `${nextStableBase}-${inputs.prereleaseIdentifier}.${nextPrereleaseNum}`;
        const candidateTag = `${inputs.tagPrefix}${newVersion}`;

        if (await tagExists(candidateTag)) {
          logger.warn(`Tag ${candidateTag} already exists, trying next...`);
          nextPrereleaseNum++;
        } else {
          logger.info(`Using version: ${newVersion}`);
          break;
        }

        if (attempt === maxAttempts - 1) {
          throw new Error(
            `Could not find available version after ${maxAttempts} attempts. Last tried: ${candidateTag}`,
          );
        }
      }
    } else {
      // Stable release: bump from base version
      if (bumpType === "none") {
        logger.info("No version-bumping commits since last tag, skipping version bump");
        core.setOutput("version", "");
        core.setOutput("previous_version", packageVersion);
        core.setOutput("bump_type", "none");
        core.setOutput("tag", "");
        core.setOutput("is_prerelease", "false");
        core.setOutput("skipped", "true");
        return;
      }

      newVersion = bumpVersion(packageVersion, bumpType);
      logger.info(`Bumping version: ${packageVersion} -> ${newVersion} (${bumpType})`);
    }

    const tag = `${inputs.tagPrefix}${newVersion}`;
    const isPrerelease = inputs.releasePrerelease || newVersion.includes("-");

    // Generate changelog
    let changelog = "";
    if (inputs.generateChangelog) {
      // For prereleases, derive nextStableBase again for the changelog ref lookup
      const changelogBase = inputs.releasePrerelease ? newVersion.replace(/-.*$/, "") : undefined;
      const changelogRef = inputs.releasePrerelease
        ? (await getLatestPrereleaseTagForVersion(changelogBase!, inputs.prereleaseIdentifier, inputs.tagPrefix)) ||
          latestStableTag
        : latestStableTag;
      changelog = await generateChangelog(changelogRef, commitScope(inputs, workingDir));
      logger.info("Generated changelog", { referenceTag: changelogRef });
    }

    // Set outputs (always set, even in dry run)
    core.setOutput("previous_version", packageVersion);
    core.setOutput("version", newVersion);
    core.setOutput("bump_type", bumpType);
    core.setOutput("tag", tag);
    core.setOutput("is_prerelease", String(isPrerelease));

    // Handle dry run mode
    if (inputs.dryRun) {
      logger.info("[DRY RUN] Would perform the following actions:");
      logger.info(`  - Version: ${packageVersion} -> ${newVersion}`);
      logger.info(`  - Tag: ${tag}`);
      logger.info(`  - Bump type: ${bumpType}`);
      logger.info(`  - Is prerelease: ${isPrerelease}`);

      if (inputs.updateVersionFile) {
        logger.info(`  - Would update version file to ${newVersion}`);
      }
      if (inputs.createTag) {
        logger.info(`  - Would create git tag: ${tag}`);
        if (inputs.pushChanges) {
          logger.info("  - Would push changes and tag to remote");
        }
      }
      if (inputs.createRelease) {
        logger.info(`  - Would create GitHub release: ${tag}`);
      }
      if (changelog) {
        logger.info("  - Changelog preview:");
        for (const line of changelog.split("\n").slice(0, 10)) {
          logger.info(`    ${line}`);
        }
        if (changelog.split("\n").length > 10) {
          logger.info("    ... (truncated)");
        }
      }

      core.info(`[DRY RUN] Version bump analysis complete: ${tag}`);
      return;
    }

    // Update version file, commit, and tag
    if (inputs.updateVersionFile) {
      await updateVersionFile(workingDir, newVersion);
      await exec.exec("git", ["add", "-A"], { cwd: workingDir });
      await exec.exec("git", ["commit", "-m", `chore(release): ${tag}`]);
      logger.info(`Committed version bump to ${newVersion}`);
    }

    if (inputs.createTag) {
      const tagAlreadyExists = await tagExists(tag);
      if (tagAlreadyExists) {
        logger.warn(`Tag ${tag} already exists, skipping tag creation`);
      } else {
        await exec.exec("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
        logger.info(`Created tag ${tag}`);
      }
    }

    if (inputs.pushChanges) {
      // Only push HEAD when updateVersionFile actually committed something —
      // pushing a tag does NOT require pushing HEAD, and doing so unconditionally
      // races with other concurrent jobs / commits and fails non-fast-forward.
      if (inputs.updateVersionFile) {
        await exec.exec("git", ["push", "--set-upstream", "origin", "HEAD"]);
      }
      if (inputs.createTag) {
        await exec.exec("git", ["push", "origin", tag]);
      }
      if (inputs.updateVersionFile || inputs.createTag) {
        logger.info("Pushed changes and tag");
      }
    }

    // Create GitHub release (idempotent - updates if exists)
    if (inputs.createRelease) {
      const octokit = github.getOctokit(inputs.githubToken);
      const { owner, repo } = github.context.repo;

      let release: { data: { html_url: string } };
      try {
        const existingRelease = await octokit.rest.repos.getReleaseByTag({
          owner,
          repo,
          tag,
        });

        release = await octokit.rest.repos.updateRelease({
          owner,
          repo,
          release_id: existingRelease.data.id,
          name: isPrerelease ? `${tag} (Pre-release)` : tag,
          body: changelog,
          draft: inputs.releaseDraft,
          prerelease: isPrerelease,
        });

        logger.info("Updated existing GitHub release", { url: release.data.html_url });
      } catch (error: unknown) {
        const isNotFound = error instanceof Object && "status" in error && (error as { status: number }).status === 404;
        if (isNotFound) {
          release = await octokit.rest.repos.createRelease({
            owner,
            repo,
            tag_name: tag,
            name: isPrerelease ? `${tag} (Pre-release)` : tag,
            body: changelog,
            draft: inputs.releaseDraft,
            prerelease: isPrerelease,
          });

          logger.info("Created GitHub release", { url: release.data.html_url });
        } else {
          throw error;
        }
      }

      core.setOutput("release_url", release.data.html_url);
    }

    logger.info(`Version bump complete: ${tag}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
