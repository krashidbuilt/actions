/**
 * TypeScript Setup Action - Business Logic
 *
 * Sets up Node.js and Bun, configures authentication for npm registries,
 * and detects the project's package manager.
 */

import { existsSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import { common, detectPackageManager, Logger, registry, runtime } from "../../../core/index.js";

const logger = new Logger({ prefix: "typescript/setup" });

interface SetupInputs {
  nodeVersion: string;
  bunVersion: string;
  workingDirectory: string;
  registryAuthToken: string;
  registryUrl: string;
  registryScope: string;
}

function getInputs(): SetupInputs {
  return {
    nodeVersion: runtime.nodeVersion(),
    bunVersion: runtime.bunVersion(),
    workingDirectory: common.workingDirectory(),
    registryAuthToken: registry.authToken(),
    registryUrl: registry.url(),
    registryScope: registry.scope(),
  };
}

function getNodeDownloadUrl(version: string): string {
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = process.platform === "win32" ? "zip" : "tar.gz";

  return `https://nodejs.org/dist/v${version}/node-v${version}-${platform}-${arch}.${ext}`;
}

async function resolveNodeVersion(version: string): Promise<string> {
  if (/^\d+\.\d+\.\d+$/.test(version)) {
    return version;
  }

  try {
    const response = await fetch("https://nodejs.org/dist/index.json");
    const versions = (await response.json()) as Array<{
      version: string;
      lts: boolean | string;
    }>;

    const majorVersion = version.replace(/^v/, "").split(".")[0];
    const matching = versions.find((v) => v.version.startsWith(`v${majorVersion}.`));

    if (matching) {
      return matching.version.replace(/^v/, "");
    }
  } catch (error) {
    logger.warn(`Failed to resolve Node.js version, using default: ${error}`);
  }

  return `${version}.0.0`;
}

async function setupNode(version: string): Promise<string> {
  logger.info(`Setting up Node.js ${version}`);

  const resolvedVersion = await resolveNodeVersion(version);
  logger.info(`Resolved Node.js version: ${resolvedVersion}`);

  // Check if Node is already available at the right version
  try {
    let currentVersion = "";
    await exec.exec("node", ["--version"], {
      listeners: {
        stdout: (data) => {
          currentVersion += data.toString();
        },
      },
      silent: true,
    });

    const currentMajor = currentVersion.trim().replace(/^v/, "").split(".")[0];
    const requestedMajor = resolvedVersion.split(".")[0];

    if (currentMajor === requestedMajor) {
      logger.info(
        `Node.js ${currentVersion.trim()} already installed (matches requested major version ${requestedMajor})`,
      );
      return currentVersion.trim();
    }

    logger.info(`Current Node.js ${currentVersion.trim()} doesn't match requested ${version}, installing...`);
  } catch {
    logger.info("Node.js not found, installing...");
  }

  core.warning("Node.js download fallback is deprecated. Add actions/setup-node@v4 before this step.");

  // Check tool cache first
  let toolPath = tc.find("node", resolvedVersion);

  if (toolPath) {
    logger.info(`Found Node.js ${resolvedVersion} in tool cache`);
  } else {
    const downloadUrl = getNodeDownloadUrl(resolvedVersion);
    logger.info(`Downloading Node.js from ${downloadUrl}`);

    const downloadPath = await tc.downloadTool(downloadUrl);

    let extractedPath: string;
    if (process.platform === "win32") {
      extractedPath = await tc.extractZip(downloadPath);
    } else {
      extractedPath = await tc.extractTar(downloadPath);
    }

    const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const nodeDir = resolve(extractedPath, `node-v${resolvedVersion}-${platform}-${arch}`);

    toolPath = await tc.cacheDir(nodeDir, "node", resolvedVersion);
    logger.info(`Cached Node.js ${resolvedVersion} to ${toolPath}`);
  }

  const binPath = process.platform === "win32" ? toolPath : resolve(toolPath, "bin");
  core.addPath(binPath);

  let installedVersion = "";
  await exec.exec("node", ["--version"], {
    listeners: {
      stdout: (data) => {
        installedVersion += data.toString();
      },
    },
  });

  logger.info(`Node.js ${installedVersion.trim()} installed successfully`);
  return installedVersion.trim();
}

function getBunDownloadUrl(version: string): string {
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x64";

  return `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${platform}-${arch}.zip`;
}

async function setupBun(version: string): Promise<string> {
  logger.info(`Setting up Bun ${version}`);

  // Check if Bun is already installed with the right version
  try {
    let currentVersion = "";
    await exec.exec("bun", ["--version"], {
      listeners: {
        stdout: (data) => {
          currentVersion += data.toString();
        },
      },
      silent: true,
    });

    const current = currentVersion.trim();
    if (current.startsWith(version.split(".")[0])) {
      logger.info(`Bun ${current} already installed`);
      return current;
    }

    logger.info(`Current Bun ${current} doesn't match requested ${version}, installing...`);
  } catch {
    logger.info("Bun not found, installing...");
  }

  let toolPath = tc.find("bun", version);

  if (toolPath) {
    logger.info(`Found Bun ${version} in tool cache`);
  } else {
    const downloadUrl = getBunDownloadUrl(version);
    logger.info(`Downloading Bun from ${downloadUrl}`);

    const downloadPath = await tc.downloadTool(downloadUrl);
    const extractedPath = await tc.extractZip(downloadPath);

    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "aarch64" : "x64";
    const bunDir = resolve(extractedPath, `bun-${platform}-${arch}`);

    if (existsSync(bunDir)) {
      toolPath = await tc.cacheDir(bunDir, "bun", version);
    } else {
      toolPath = await tc.cacheDir(extractedPath, "bun", version);
    }

    logger.info(`Cached Bun ${version} to ${toolPath}`);
  }

  core.addPath(toolPath);

  // Ensure bunx exists — symlink can be lost during zip extraction
  const bunxPath = resolve(toolPath, "bunx");
  const bunPath = resolve(toolPath, "bun");
  if (!existsSync(bunxPath) && existsSync(bunPath)) {
    symlinkSync(bunPath, bunxPath);
    logger.info("Created bunx symlink");
  }

  let installedVersion = "";
  await exec.exec("bun", ["--version"], {
    listeners: {
      stdout: (data) => {
        installedVersion += data.toString();
      },
    },
  });

  logger.info(`Bun ${installedVersion.trim()} installed successfully`);
  return installedVersion.trim();
}

async function configureRegistry(inputs: SetupInputs): Promise<void> {
  logger.info("Configuring npm registry authentication");

  core.exportVariable("NODE_AUTH_TOKEN", inputs.registryAuthToken);
  core.exportVariable("BUN_AUTH_TOKEN", inputs.registryAuthToken);

  await exec.exec("npm", ["config", "set", `${inputs.registryScope}:registry`, inputs.registryUrl]);

  const registryHost = new URL(inputs.registryUrl).host;
  await exec.exec("npm", ["config", "set", `//${registryHost}/:_authToken`, inputs.registryAuthToken]);

  logger.info("Registry authentication configured");
}

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);

    logger.info("Starting TypeScript setup", { workingDirectory: workingDir });

    // Detect package manager
    const pmInfo = detectPackageManager(workingDir, { allowNoLockfile: true });
    logger.info(`Package manager: ${pmInfo.packageManager}`, pmInfo);
    core.setOutput("package_manager", pmInfo.packageManager);

    // Setup Node.js
    const nodeVersion = await setupNode(inputs.nodeVersion);
    core.setOutput("node_version", nodeVersion);

    // Setup Bun
    const bunVersion = await setupBun(inputs.bunVersion);
    core.setOutput("bun_version", bunVersion);

    // Configure registry authentication
    if (inputs.registryAuthToken) {
      await configureRegistry(inputs);
    }

    logger.info("TypeScript setup complete!");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
