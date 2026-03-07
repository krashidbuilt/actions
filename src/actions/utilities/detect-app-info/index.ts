/**
 * Detect App Info Action
 *
 * Detects application name and version from package.json.
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import { common, Logger, readPackageVersion, stripScope, tryReadPackageJson } from "../../../core/index.js";

const logger = new Logger({ prefix: "detect-app-info" });

async function run(): Promise<void> {
  try {
    const workingDirectory = common.workingDirectory();
    const appNameOverride = core.getInput("app_name") || undefined;
    const versionOverride = core.getInput("version_override") || undefined;
    const shouldStripScope = core.getInput("strip_scope") !== "false";

    const workingDir = resolve(workingDirectory);

    logger.info("Detecting app info", { workingDirectory: workingDir });

    const pkg = tryReadPackageJson(workingDir);

    if (!pkg) {
      throw new Error(`No package.json found at ${workingDir}`);
    }

    const packageName = pkg.name || "unknown";

    // Resolve app name
    let appName: string;
    if (appNameOverride) {
      appName = appNameOverride;
    } else if (pkg.name) {
      appName = shouldStripScope ? stripScope(pkg.name) : pkg.name;
    } else {
      throw new Error("No name found in package.json and no override provided");
    }

    // Resolve version
    let version: string;
    if (versionOverride) {
      version = versionOverride;
    } else if (pkg.version) {
      version = pkg.version;
    } else {
      try {
        version = readPackageVersion(workingDir);
      } catch {
        logger.warn("No version found, defaulting to 0.0.0");
        version = "0.0.0";
      }
    }

    const tag = `v${version}`;

    logger.info("Detected app info", {
      appName,
      version,
      tag,
      packageName,
    });

    core.setOutput("app_name", appName);
    core.setOutput("version", version);
    core.setOutput("tag", tag);
    core.setOutput("package_name", packageName);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
