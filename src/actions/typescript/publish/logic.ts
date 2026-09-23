/**
 * TypeScript Publish Action - Business Logic
 *
 * Builds and publishes an npm package.
 *
 * Two auth paths: npm trusted publishing (OIDC), which needs
 * `permissions: { id-token: write }` in the calling workflow, and token auth
 * for registries with no OIDC token exchange — set `use_oidc: false` and let
 * typescript/setup write the token into .npmrc first.
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
  useOidc: boolean;
}

function getInputs(): PublishInputs {
  const tag = core.getInput("tag", { required: true });

  return {
    workingDirectory: common.workingDirectory(),
    tag,
    skipBuild: core.getInput("skip_build") === "true",
    useOidc: core.getInput("use_oidc") !== "false",
  };
}

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);

    logger.info(`Publishing npm package via ${inputs.useOidc ? "OIDC trusted publishing" : "registry token"}`, {
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

    logger.info(`Publishing with tag: ${inputs.tag}`);

    if (inputs.useOidc) {
      // Publish via npm with OIDC provenance (trusted publishing)
      // npm CLI 11.5.1+ auto-detects OIDC environment and handles token exchange.
      // NODE_AUTH_TOKEN must NOT be set — it would override OIDC.
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
    } else {
      // Token auth. Keep NODE_AUTH_TOKEN — it is what authenticates here — and
      // drop --provenance/--access: both are npmjs-only, and access is already
      // declared by the package's own publishConfig.
      await exec.exec("npm", ["publish", "--tag", inputs.tag], {
        cwd: workingDir,
      });
    }

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
