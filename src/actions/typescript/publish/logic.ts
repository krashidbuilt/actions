/**
 * TypeScript Publish Action - Business Logic
 *
 * Builds and publishes an npm package using npm trusted publishing (OIDC).
 * Requires `permissions: { id-token: write }` in the calling workflow.
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { common, detectPackageManager, getRunCommand, Logger, readPackageJson } from "../../../core/index.js";

const logger = new Logger({ prefix: "typescript/publish" });

interface PublishInputs {
  workingDirectory: string;
  tag: string;
  skipBuild: boolean;
}

function getInputs(): PublishInputs {
  const tag = core.getInput("tag", { required: true });

  return {
    workingDirectory: common.workingDirectory(),
    tag,
    skipBuild: core.getInput("skip_build") === "true",
  };
}

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);

    logger.info("Publishing npm package via OIDC trusted publishing", {
      workingDirectory: workingDir,
      tag: inputs.tag,
    });

    // Read package info
    const pkg = readPackageJson(workingDir);
    const version = pkg.version || "unknown";
    logger.info(`Package: ${pkg.name}@${version}`);

    // Detect package manager for build step
    const pmInfo = detectPackageManager(workingDir, {
      allowNoLockfile: true,
    });

    // Build if not skipped
    if (!inputs.skipBuild && pkg.scripts?.build) {
      logger.info("Running build...");
      const buildCmd = getRunCommand(pmInfo.packageManager, "build");
      const [cmd, ...args] = buildCmd.split(" ");
      await exec.exec(cmd, args, { cwd: workingDir });
      logger.info("Build completed");
    }

    // Publish via npm with OIDC provenance (trusted publishing)
    // npm CLI 11.5.1+ auto-detects OIDC environment and handles token exchange.
    // NODE_AUTH_TOKEN must NOT be set — it would override OIDC.
    logger.info(`Publishing with tag: ${inputs.tag}`);
    const publishEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== "NODE_AUTH_TOKEN" && key !== "BUN_AUTH_TOKEN" && value !== undefined) {
        publishEnv[key] = value;
      }
    }

    await exec.exec("npm", ["publish", "--provenance", "--access", "public", "--tag", inputs.tag], {
      cwd: workingDir,
      env: publishEnv,
    });

    core.setOutput("published", "true");
    core.setOutput("version", version);
    core.setOutput("tag", inputs.tag);

    logger.info(`Successfully published ${pkg.name}@${version} with tag ${inputs.tag}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
