/**
 * Version detection and management utilities
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as exec from "@actions/exec";
import { Logger } from "./logger.js";
import { readPackageJson } from "./package-json.js";
import type { VersionBumpType, VersionInfo } from "./types.js";

const logger = new Logger({ prefix: "version" });

export function readPackageVersion(workingDirectory = "."): string {
  const pkg = readPackageJson(resolve(workingDirectory));

  if (!pkg.version) {
    throw new Error("No version field found in package.json");
  }

  logger.debug("Read version from package.json", { version: pkg.version });
  return pkg.version;
}

export function readProjectVersion(workingDirectory = "."): string {
  const resolvedDir = resolve(workingDirectory);
  const packageJsonPath = join(resolvedDir, "package.json");

  if (existsSync(packageJsonPath)) {
    return readPackageVersion(workingDirectory);
  }

  throw new Error(`No package.json found at ${resolvedDir}`);
}

/** The tag prefix every version tag has unless a caller asks for another one. */
export const DEFAULT_TAG_PREFIX = "v";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex source matching a tag's prefix. The default prefix stays optional, so bare
 * `X.Y.Z` tags keep matching as they always have; any other prefix is required.
 */
function tagPrefixPattern(tagPrefix: string): string {
  return tagPrefix === DEFAULT_TAG_PREFIX ? "v?" : escapeRegExp(tagPrefix);
}

/**
 * Remove the tag prefix from a tag or version string (`v1.2.3` -> `1.2.3`, or
 * `review-access-v1.2.3` -> `1.2.3` with that prefix). Strings without it are returned unchanged.
 */
export function stripTagPrefix(value: string, tagPrefix = DEFAULT_TAG_PREFIX): string {
  if (tagPrefix === DEFAULT_TAG_PREFIX) {
    return value.replace(/^v/, "");
  }
  return value.startsWith(tagPrefix) ? value.slice(tagPrefix.length) : value;
}

/**
 * Get the latest git tag that matches semver format, considering only tags with `tagPrefix`
 */
export async function getLatestGitTag(stableOnly = false, tagPrefix = DEFAULT_TAG_PREFIX): Promise<string | null> {
  let output = "";

  try {
    await exec.exec("git", ["tag", "--sort=-v:refname"], {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString();
        },
      },
      silent: true,
    });

    const tags = output.trim().split("\n");
    const prefix = tagPrefixPattern(tagPrefix);
    const semverRegex = new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+(-[a-zA-Z0-9]+(\\.\\d+)?)?$`);
    const stableSemverRegex = new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+$`);

    const regex = stableOnly ? stableSemverRegex : semverRegex;
    const semverTag = tags.find((tag) => regex.test(tag.trim()));

    if (semverTag) {
      const tag = semverTag.trim();
      logger.debug(`Found latest ${stableOnly ? "stable " : ""}semver git tag`, { tag });
      return tag;
    }

    logger.debug(`No ${stableOnly ? "stable " : ""}semver git tags found`);
    return null;
  } catch {
    logger.debug("No git tags found");
    return null;
  }
}

/**
 * Get the latest prerelease tag for a specific base version, considering only tags with `tagPrefix`
 */
export async function getLatestPrereleaseTagForVersion(
  baseVersion: string,
  prereleaseIdentifier = "alpha",
  tagPrefix = DEFAULT_TAG_PREFIX,
): Promise<string | null> {
  let output = "";

  try {
    await exec.exec("git", ["tag", "--sort=-v:refname"], {
      listeners: {
        stdout: (data: Buffer) => {
          output += data.toString();
        },
      },
      silent: true,
    });

    const tags = output.trim().split("\n");
    const baseNormalized = stripTagPrefix(baseVersion, tagPrefix);
    const tagRegex = new RegExp(
      `^${tagPrefixPattern(tagPrefix)}${baseNormalized.replace(/\./g, "\\.")}-${prereleaseIdentifier}\\.(\\d+)$`,
    );

    const matchingTag = tags.find((tag) => tagRegex.test(tag.trim()));

    if (matchingTag) {
      const tag = matchingTag.trim();
      logger.debug("Found latest prerelease tag for version", { baseVersion, tag });
      return tag;
    }

    logger.debug("No prerelease tags found for version", { baseVersion });
    return null;
  } catch {
    logger.debug("Error finding prerelease tags");
    return null;
  }
}

export async function tagExists(tag: string): Promise<boolean> {
  try {
    const localExitCode = await exec.exec("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
      silent: true,
      ignoreReturnCode: true,
    });
    if (localExitCode === 0) {
      return true;
    }

    let remoteOutput = "";
    const remoteExitCode = await exec.exec("git", ["ls-remote", "--tags", "origin", tag], {
      silent: true,
      ignoreReturnCode: true,
      listeners: {
        stdout: (data) => {
          remoteOutput += data.toString();
        },
      },
    });

    return remoteExitCode === 0 && remoteOutput.trim().length > 0;
  } catch {
    return false;
  }
}

export function parseVersion(
  versionString: string,
  tagPrefix = DEFAULT_TAG_PREFIX,
): {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
} {
  const normalized = stripTagPrefix(versionString, tagPrefix);

  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) {
    throw new Error(`Invalid version format: ${versionString}`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4],
  };
}

export function bumpVersion(
  currentVersion: string,
  bumpType: VersionBumpType,
  options?: { prerelease?: boolean; prereleaseIdentifier?: string },
): string {
  const parsed = parseVersion(currentVersion);
  const prereleaseId = options?.prereleaseIdentifier || "alpha";

  if (options?.prerelease) {
    if (parsed.prerelease?.startsWith(prereleaseId)) {
      const prereleaseMatch = parsed.prerelease.match(new RegExp(`^${prereleaseId}\\.(\\d+)$`));
      if (prereleaseMatch) {
        const prereleaseNum = Number.parseInt(prereleaseMatch[1], 10) + 1;
        return `${parsed.major}.${parsed.minor}.${parsed.patch}-${prereleaseId}.${prereleaseNum}`;
      }
    }

    switch (bumpType) {
      case "major":
        return `${parsed.major + 1}.0.0-${prereleaseId}.1`;
      case "minor":
        return `${parsed.major}.${parsed.minor + 1}.0-${prereleaseId}.1`;
      case "patch":
        return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-${prereleaseId}.1`;
    }
  }

  if (parsed.prerelease) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }

  switch (bumpType) {
    case "major":
      return `${parsed.major + 1}.0.0`;
    case "minor":
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case "patch":
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
}

export async function getVersionInfo(workingDirectory = ".", tagPrefix = DEFAULT_TAG_PREFIX): Promise<VersionInfo> {
  const current = readPackageVersion(workingDirectory);
  const latestTag = await getLatestGitTag(false, tagPrefix);
  const parsed = parseVersion(current);

  const info: VersionInfo = {
    current,
    previous: latestTag ? stripTagPrefix(latestTag, tagPrefix) : undefined,
    tag: `${tagPrefix}${current}`,
    isPrerelease: !!parsed.prerelease,
  };

  logger.debug("Version info", info);
  return info;
}

export function determineBumpType(previousVersion: string, currentVersion: string): VersionBumpType | null {
  const prev = parseVersion(previousVersion);
  const curr = parseVersion(currentVersion);

  if (curr.major > prev.major) return "major";
  if (curr.minor > prev.minor) return "minor";
  if (curr.patch > prev.patch) return "patch";

  return null;
}

export function determineBumpTypeFromCommits(commits: string[]): VersionBumpType | "none" {
  if (commits.length === 0) {
    return "none";
  }

  if (commits.some((c) => c.includes("BREAKING CHANGE") || c.includes("BREAKING-CHANGE") || c.includes("!:"))) {
    return "major";
  }

  if (commits.some((c) => /^[a-f0-9]+ (feat|feature)(\(|:)/i.test(c))) {
    return "minor";
  }

  return "patch";
}
