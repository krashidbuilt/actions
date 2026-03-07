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

/**
 * Get the latest git tag that matches semver format
 */
export async function getLatestGitTag(stableOnly = false): Promise<string | null> {
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
    const semverRegex = /^v?\d+\.\d+\.\d+(-[a-zA-Z0-9]+(\.\d+)?)?$/;
    const stableSemverRegex = /^v?\d+\.\d+\.\d+$/;

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
 * Get the latest prerelease tag for a specific base version
 */
export async function getLatestPrereleaseTagForVersion(
  baseVersion: string,
  prereleaseIdentifier = "alpha",
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
    const baseNormalized = baseVersion.replace(/^v/, "");
    const tagRegex = new RegExp(`^v?${baseNormalized.replace(/\./g, "\\.")}-${prereleaseIdentifier}\\.(\\d+)$`);

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

export function parseVersion(versionString: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
} {
  const normalized = versionString.replace(/^v/, "");

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

export async function getVersionInfo(workingDirectory = "."): Promise<VersionInfo> {
  const current = readPackageVersion(workingDirectory);
  const latestTag = await getLatestGitTag();
  const parsed = parseVersion(current);

  const info: VersionInfo = {
    current,
    previous: latestTag ? latestTag.replace(/^v/, "") : undefined,
    tag: `v${current}`,
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
