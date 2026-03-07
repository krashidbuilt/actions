/**
 * Merge Branch Logic
 *
 * Merges one branch into one or more target branches with proper handling.
 */

import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { configureGitIdentity, git, Logger } from "../../../core/index.js";

const logger = new Logger({ prefix: "merge-branch" });

export function getTargetBranches(): string[] {
  const targetBranches = core.getInput("target_branches");
  const targetBranch = core.getInput("target_branch");

  if (targetBranches) {
    return targetBranches
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
  }

  if (targetBranch) {
    return [targetBranch.trim()];
  }

  throw new Error("Either target_branch or target_branches must be provided");
}

export async function mergeBranch(sourceBranch: string, targetBranch: string, message: string): Promise<void> {
  await exec("git", ["fetch", "origin", targetBranch]);
  await exec("git", ["checkout", targetBranch]);
  await exec("git", ["reset", "--hard", `origin/${targetBranch}`]);
  await exec("git", ["merge", sourceBranch, "--no-edit", "-m", message]);
  await exec("git", ["push", "origin", targetBranch]);
}

export async function run(): Promise<void> {
  try {
    const sourceBranch = core.getInput("source_branch", { required: true });
    const targetBranches = getTargetBranches();
    const messageTemplate = core.getInput("message");
    const dryRun = core.getBooleanInput("dry_run");

    await configureGitIdentity(git.userName(), git.userEmail());

    logger.info("Merging branches", {
      source: sourceBranch,
      targets: targetBranches,
      messageTemplate,
      dryRun,
    });

    if (dryRun) {
      for (const target of targetBranches) {
        core.info(`[DRY RUN] Would merge ${sourceBranch} into ${target}`);
      }
      core.setOutput("merged", "false");
      core.setOutput("merged_branches", "");
      core.setOutput("failed_branches", "");
      return;
    }

    const mergedBranches: string[] = [];
    const failedBranches: string[] = [];

    for (const targetBranch of targetBranches) {
      const message =
        messageTemplate?.replace("{target}", targetBranch) || `chore: merge ${sourceBranch} into ${targetBranch}`;

      try {
        logger.info(`Merging ${sourceBranch} into ${targetBranch}...`);
        await mergeBranch(sourceBranch, targetBranch, message);
        logger.info(`Successfully merged ${sourceBranch} into ${targetBranch}`);
        mergedBranches.push(targetBranch);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logger.error(`Failed to merge into ${targetBranch}`, new Error(errorMessage));
        core.warning(`Failed to merge ${sourceBranch} into ${targetBranch}: ${errorMessage}`);
        failedBranches.push(targetBranch);
      }
    }

    core.setOutput("merged", mergedBranches.length > 0 ? "true" : "false");
    core.setOutput("merged_branches", mergedBranches.join(","));
    core.setOutput("failed_branches", failedBranches.join(","));

    if (failedBranches.length > 0 && mergedBranches.length === 0) {
      core.setFailed(`All merges failed: ${failedBranches.join(", ")}`);
    } else if (failedBranches.length > 0) {
      core.warning(`Some merges failed: ${failedBranches.join(", ")}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
