/**
 * TypeScript Verify Action - Business Logic
 *
 * Runs build, verify, and optionally test scripts for a TypeScript project.
 * Detects the package manager and runs scripts sequentially with proper
 * error reporting.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { common, detectPackageManager, getRunCommand, Logger, type PackageManager } from "../../../core/index.js";

const logger = new Logger({ prefix: "typescript/verify" });

interface VerifyInputs {
  workingDirectory: string;
  packageManagerHint: PackageManager | "auto";
  runBuild: boolean;
  runVerify: boolean;
  runTests: boolean;
  nodeOptions: string;
}

function getInputs(): VerifyInputs {
  return {
    workingDirectory: common.workingDirectory(),
    packageManagerHint: (core.getInput("package_manager") || "auto") as PackageManager | "auto",
    runBuild: core.getInput("run_build") !== "false",
    runVerify: core.getInput("run_verify") !== "false",
    runTests: core.getInput("run_tests") === "true",
    nodeOptions: core.getInput("node_options") || "--max-old-space-size=8192",
  };
}

function hasScript(packageJsonPath: string, scriptName: string): boolean {
  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
    return !!pkg.scripts?.[scriptName];
  } catch {
    return false;
  }
}

interface ScriptResult {
  success: boolean;
  stepName: string;
  exitCode?: number;
}

async function runScript(
  packageManager: PackageManager,
  script: string,
  workingDirectory: string,
  env: Record<string, string>,
  stepName: string,
): Promise<ScriptResult> {
  const cmd = getRunCommand(packageManager, script);
  const [executable, ...args] = cmd.split(" ");

  const mergedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      mergedEnv[key] = value;
    }
  }
  Object.assign(mergedEnv, env);

  try {
    await exec.exec(executable, args, {
      cwd: workingDirectory,
      env: mergedEnv,
    });
    logger.info(`${stepName} completed successfully`);
    return { success: true, stepName };
  } catch (error) {
    const exitCode = error instanceof Error && "exitCode" in error ? (error as { exitCode: number }).exitCode : 1;
    logger.error(`${stepName} failed with exit code ${exitCode}`);
    return { success: false, stepName, exitCode };
  }
}

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);
    const packageJsonPath = resolve(workingDir, "package.json");

    logger.info("Starting TypeScript verification", {
      workingDirectory: workingDir,
    });

    // Detect package manager
    const pmInfo = detectPackageManager(workingDir, {
      hint: inputs.packageManagerHint,
      allowNoLockfile: true,
    });
    const pm = pmInfo.packageManager;
    logger.info(`Using package manager: ${pm}`);

    const buildEnv: Record<string, string> = {
      NODE_OPTIONS: inputs.nodeOptions,
    };

    // Run build if requested and script exists
    if (inputs.runBuild && hasScript(packageJsonPath, "build")) {
      logger.info("Running build script");
      const buildResult = await runScript(pm, "build", workingDir, buildEnv, "Build");
      core.setOutput("build_success", buildResult.success.toString());

      if (!buildResult.success) {
        core.setOutput("verify_success", "false");
        core.setOutput("test_success", "false");
        core.setFailed(`Build failed (exit code ${buildResult.exitCode || 1})`);
        return;
      }
    } else {
      core.setOutput("build_success", "true");
    }

    // Run verify
    if (inputs.runVerify && hasScript(packageJsonPath, "verify")) {
      logger.info("Running verify script");
      const verifyResult = await runScript(pm, "verify", workingDir, buildEnv, "Verify");
      core.setOutput("verify_success", verifyResult.success.toString());

      if (!verifyResult.success) {
        core.setOutput("test_success", "false");
        core.setFailed(`Verification failed (exit code ${verifyResult.exitCode || 1})`);
        return;
      }
    } else {
      core.setOutput("verify_success", "true");
    }

    // Run tests if requested
    if (inputs.runTests && hasScript(packageJsonPath, "test")) {
      logger.info("Running test script");
      const testResult = await runScript(pm, "test", workingDir, buildEnv, "Test");
      core.setOutput("test_success", testResult.success.toString());

      if (!testResult.success) {
        core.setFailed(`Tests failed (exit code ${testResult.exitCode || 1})`);
        return;
      }
    } else {
      core.setOutput("test_success", "true");
    }

    logger.info("TypeScript verification complete!");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
