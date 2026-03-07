/**
 * Package manager detection utilities
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Logger } from "./logger.js";
import type { PackageManager, PackageManagerInfo } from "./types.js";

const logger = new Logger({ prefix: "package-manager" });

const LOCKFILE_CONFIG: Record<PackageManager, string[]> = {
  bun: ["bun.lock", "bun.lockb"],
  yarn: ["yarn.lock"],
  npm: ["package-lock.json"],
};

const DETECTION_ORDER: PackageManager[] = ["bun", "yarn", "npm"];

interface DetectOptions {
  hint?: PackageManager | "auto";
  allowNoLockfile?: boolean;
}

export function detectPackageManager(workingDirectory = ".", options: DetectOptions = {}): PackageManagerInfo {
  const { hint, allowNoLockfile = false } = options;
  const resolvedDir = resolve(workingDirectory);
  logger.debug("Detecting package manager", { workingDirectory: resolvedDir, hint, allowNoLockfile });

  if (hint && hint !== "auto") {
    const lockfiles = LOCKFILE_CONFIG[hint];
    for (const lockfile of lockfiles) {
      const lockfilePath = join(resolvedDir, lockfile);
      if (existsSync(lockfilePath)) {
        logger.info(`Using hinted package manager: ${hint}`);
        return {
          packageManager: hint,
          hasLockfile: true,
          lockfilePath,
          lockfileName: lockfile,
        };
      }
    }

    logger.warn(`Hinted package manager ${hint} has no lockfile`);
    return {
      packageManager: hint,
      hasLockfile: false,
    };
  }

  for (const pm of DETECTION_ORDER) {
    const lockfiles = LOCKFILE_CONFIG[pm];
    for (const lockfile of lockfiles) {
      const lockfilePath = join(resolvedDir, lockfile);
      if (existsSync(lockfilePath)) {
        logger.info(`Detected package manager: ${pm} (found ${lockfile})`);
        return {
          packageManager: pm,
          hasLockfile: true,
          lockfilePath,
          lockfileName: lockfile,
        };
      }
    }
  }

  if (allowNoLockfile) {
    logger.info("No lockfile found, defaulting to bun (allowNoLockfile=true)");
    return {
      packageManager: "bun",
      hasLockfile: false,
    };
  }

  const checkedFiles = DETECTION_ORDER.flatMap((pm) => LOCKFILE_CONFIG[pm]);
  throw new Error(
    `Unable to detect package manager. None of these lockfiles found in ${resolvedDir}: ${checkedFiles.join(", ")}`,
  );
}

export function getInstallCommand(packageManager: PackageManager, frozen = true): string {
  switch (packageManager) {
    case "bun":
      return frozen ? "bun install --frozen-lockfile" : "bun install";
    case "yarn":
      return frozen ? "yarn install --immutable" : "yarn install";
    case "npm":
      return frozen ? "npm ci" : "npm install";
  }
}

export function getRunCommand(packageManager: PackageManager, script: string): string {
  switch (packageManager) {
    case "bun":
      return `bun run ${script}`;
    case "yarn":
      return `yarn run ${script}`;
    case "npm":
      return `npm run ${script}`;
  }
}
