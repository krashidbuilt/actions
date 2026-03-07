/**
 * Build Binary Logic
 *
 * Builds a standalone binary using bun build --compile.
 * Used for daemon distribution as platform-specific binaries.
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { common, Logger } from "../../../core/index.js";

const logger = new Logger({ prefix: "deploy/build-binary" });

export interface BuildBinaryInputs {
  entry: string;
  target: string;
  outfile: string;
  workingDirectory: string;
}

export function getInputs(): BuildBinaryInputs {
  return {
    entry: core.getInput("entry", { required: true }),
    target: core.getInput("target", { required: true }),
    outfile: core.getInput("outfile", { required: true }),
    workingDirectory: common.workingDirectory(),
  };
}

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);

    logger.info("Building binary", {
      entry: inputs.entry,
      target: inputs.target,
      outfile: inputs.outfile,
      workingDirectory: workingDir,
    });

    await exec.exec(
      "bun",
      ["build", "--compile", "--target", inputs.target, "--outfile", inputs.outfile, inputs.entry],
      { cwd: workingDir },
    );

    const artifactPath = resolve(workingDir, inputs.outfile);
    core.setOutput("artifact_path", artifactPath);

    logger.info(`Binary built successfully: ${artifactPath}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
