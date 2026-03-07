/**
 * Parse Version Action
 *
 * Parses a semver version string and extracts components.
 * Supports multiple version sources with fallback logic.
 */

import * as core from "@actions/core";
import { Logger, parseVersion } from "../../../core/index.js";

const logger = new Logger({ prefix: "parse-version" });

async function run(): Promise<void> {
  try {
    const primaryVersion = core.getInput("version");
    const fallbackVersion = core.getInput("fallback_version");

    const versionInput = primaryVersion || fallbackVersion;

    if (!versionInput) {
      logger.info("No version provided");
      core.setOutput("version", "");
      core.setOutput("tag", "");
      core.setOutput("major", "");
      core.setOutput("minor", "");
      core.setOutput("patch", "");
      core.setOutput("prerelease", "");
      core.setOutput("is_prerelease", "false");
      core.setOutput("base_version", "");
      return;
    }

    const version = versionInput.startsWith("v") ? versionInput.slice(1) : versionInput;

    logger.info("Parsing version", { version, source: primaryVersion ? "primary" : "fallback" });

    const parsed = parseVersion(version);

    const tag = `v${version}`;
    const major = `v${parsed.major}`;
    const isPrerelease = !!parsed.prerelease;
    const baseVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;

    logger.info("Parsed version", {
      version,
      tag,
      major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: parsed.prerelease || "",
      isPrerelease,
      baseVersion,
    });

    core.setOutput("version", version);
    core.setOutput("tag", tag);
    core.setOutput("major", major);
    core.setOutput("minor", parsed.minor.toString());
    core.setOutput("patch", parsed.patch.toString());
    core.setOutput("prerelease", parsed.prerelease || "");
    core.setOutput("is_prerelease", isPrerelease.toString());
    core.setOutput("base_version", baseVersion);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
