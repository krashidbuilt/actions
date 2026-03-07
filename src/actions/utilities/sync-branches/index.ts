/**
 * Sync Branches Action
 *
 * Syncs branches with various strategies:
 * - force-sync: Force-reset target branches to match source
 * - merge: Merge source into target branches
 */

import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { configureGitIdentity, git, Logger } from "../../../core/index.js";

const logger = new Logger({ prefix: "sync-branches" });

type SyncMode = "force-sync" | "merge";

type ConflictStrategy = "fail" | "theirs";

interface SyncInputs {
  sourceBranch: string;
  targetBranches: string[];
  mode: SyncMode;
  conflictStrategy: ConflictStrategy;
  createIfMissing: boolean;
  gitUserName: string;
  gitUserEmail: string;
  dryRun: boolean;
}

function getInputs(): SyncInputs {
  const targetBranchesInput = core.getInput("target_branches", { required: true });
  const targetBranches = targetBranchesInput
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);

  if (targetBranches.length === 0) {
    throw new Error("target_branches must contain at least one branch");
  }

  return {
    sourceBranch: core.getInput("source_branch") || "develop",
    targetBranches,
    mode: (core.getInput("mode") || "force-sync") as SyncMode,
    conflictStrategy: (core.getInput("conflict_strategy") || "fail") as ConflictStrategy,
    createIfMissing: core.getInput("create_if_missing") !== "false",
    gitUserName: git.userName(),
    gitUserEmail: git.userEmail(),
    dryRun: core.getBooleanInput("dry_run"),
  };
}

async function remoteBranchExists(branch: string): Promise<boolean> {
  let output = "";
  await exec("git", ["ls-remote", "--heads", "origin", branch], {
    silent: true,
    listeners: {
      stdout: (data) => {
        output += data.toString();
      },
    },
  });
  return output.includes(branch);
}

async function forceSyncBranch(source: string, target: string, createIfMissing: boolean): Promise<void> {
  const exists = await remoteBranchExists(target);

  if (!exists && !createIfMissing) {
    throw new Error(`Target branch ${target} does not exist and create_if_missing is false`);
  }

  await exec("git", ["fetch", "origin"]);

  if (exists) {
    await exec("git", ["checkout", target]);
    await exec("git", ["reset", "--hard", `origin/${source}`]);
  } else {
    await exec("git", ["checkout", "-b", target, `origin/${source}`]);
  }

  await exec("git", ["push", "origin", target, "--force"]);
  logger.info(`Force-synced ${target} to ${source}`);
}

async function mergeBranch(
  source: string,
  target: string,
  createIfMissing: boolean,
  conflictStrategy: ConflictStrategy,
): Promise<void> {
  const exists = await remoteBranchExists(target);

  if (!exists && !createIfMissing) {
    throw new Error(`Target branch ${target} does not exist and create_if_missing is false`);
  }

  await exec("git", ["fetch", "origin"]);

  if (!exists) {
    await exec("git", ["checkout", "-b", target, `origin/${source}`]);
    await exec("git", ["push", "origin", target]);
    logger.info(`Created ${target} from ${source}`);
    return;
  }

  await exec("git", ["checkout", target]);
  const mergeArgs = ["merge", `origin/${source}`, "--no-edit"];
  if (conflictStrategy === "theirs") {
    mergeArgs.push("-X", "theirs");
  }
  await exec("git", mergeArgs);
  await exec("git", ["push", "origin", target]);
  logger.info(`Merged ${source} into ${target}`);
}

async function run(): Promise<void> {
  try {
    const inputs = getInputs();

    logger.info("Syncing branches", {
      source: inputs.sourceBranch,
      targets: inputs.targetBranches,
      mode: inputs.mode,
      dryRun: inputs.dryRun,
    });

    await configureGitIdentity(inputs.gitUserName, inputs.gitUserEmail);

    const syncedBranches: string[] = [];

    for (const target of inputs.targetBranches) {
      if (inputs.dryRun) {
        logger.info(`[DRY RUN] Would ${inputs.mode} ${target} with ${inputs.sourceBranch}`);
        continue;
      }

      if (inputs.mode === "force-sync") {
        await forceSyncBranch(inputs.sourceBranch, target, inputs.createIfMissing);
      } else {
        await mergeBranch(inputs.sourceBranch, target, inputs.createIfMissing, inputs.conflictStrategy);
      }

      syncedBranches.push(target);
    }

    core.setOutput("synced_branches", syncedBranches.join(","));
    core.setOutput("synced_count", String(syncedBranches.length));
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
