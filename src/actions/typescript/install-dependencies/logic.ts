/**
 * Install Dependencies Action - Business Logic
 *
 * Detects the package manager and installs dependencies using the
 * appropriate install command.
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import {
  common,
  detectPackageManager,
  ensureBunfig,
  ensureNpmrc,
  getInstallCommand,
  Logger,
  type PackageManager,
} from "../../../core/index.js";

const logger = new Logger({ prefix: "typescript/install-dependencies" });

interface InstallInputs {
  packageManager: PackageManager | "auto";
  workingDirectory: string;
  frozenLockfile: boolean;
}

function getInputs(): InstallInputs {
  const pm = (core.getInput("package_manager") || "auto") as PackageManager | "auto";

  if (!["npm", "yarn", "bun", "auto"].includes(pm)) {
    throw new Error(`Invalid package manager: ${pm}. Must be npm, yarn, bun, or auto.`);
  }

  return {
    packageManager: pm,
    workingDirectory: common.workingDirectory(),
    frozenLockfile: core.getInput("frozen_lockfile") !== "false",
  };
}

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);

    // Detect package manager
    let packageManager: PackageManager;
    if (inputs.packageManager === "auto") {
      const detected = detectPackageManager(workingDir, {
        allowNoLockfile: true,
      });
      packageManager = detected.packageManager;
      logger.info(`Auto-detected package manager: ${packageManager}`);
    } else {
      packageManager = inputs.packageManager;
    }

    logger.info("Installing dependencies", {
      packageManager,
      workingDirectory: workingDir,
      frozenLockfile: inputs.frozenLockfile,
    });

    core.setOutput("package_manager", packageManager);

    // Ensure registry config for private packages
    if (packageManager === "bun") {
      const result = ensureBunfig(workingDir);
      if (result.created) {
        logger.info("Created bunfig.toml for registry authentication");
      }
    } else {
      const result = ensureNpmrc(workingDir);
      if (result.created) {
        logger.info("Created .npmrc for registry authentication");
      }
    }

    // Install dependencies
    const installCmd = getInstallCommand(packageManager, inputs.frozenLockfile);
    const [cmd, ...args] = installCmd.split(" ");

    logger.info(`Running: ${installCmd}`);

    await exec.exec(cmd, args, {
      cwd: workingDir,
    });

    logger.info("Dependencies installed successfully");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
