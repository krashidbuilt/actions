/**
 * Commit Artifacts Logic
 *
 * Commits bundled artifacts to the repository.
 * Handles force-adding paths (useful for files in .gitignore) and rebasing.
 */

import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { configureGitIdentity, execGit, Logger } from "../../../core/index.js";

const logger = new Logger({ prefix: "commit-artifacts" });

export async function hasChanges(paths: string[]): Promise<boolean> {
  await exec("git", ["add", "-f", ...paths], { silent: true });

  const diffOutput = await execGit(["diff", "--cached", "--quiet"]).catch(() => "changes");
  return diffOutput === "changes";
}

export async function run(): Promise<void> {
  try {
    const paths = core.getInput("paths", { required: true }).split(/\s+/).filter(Boolean);
    const message = core.getInput("message") || "chore: bundle artifacts";
    const userName = core.getInput("git_user_name") || "github-actions[bot]";
    const userEmail = core.getInput("git_user_email") || "github-actions[bot]@users.noreply.github.com";
    const dryRun = core.getInput("dry_run") === "true";

    logger.info(dryRun ? "[DRY RUN] Checking artifacts" : "Committing artifacts", { paths, message });

    await configureGitIdentity(userName, userEmail);

    if (!(await hasChanges(paths))) {
      logger.info("No changes to commit (artifacts are up to date)");
      core.setOutput("committed", "false");
      core.setOutput("sha", "");
      return;
    }

    if (dryRun) {
      let changedFiles = "";
      await exec("git", ["diff", "--cached", "--name-only"], {
        listeners: {
          stdout: (data) => {
            changedFiles += data.toString();
          },
        },
        silent: true,
      });

      logger.info("[DRY RUN] Would commit the following files:");
      for (const file of changedFiles.trim().split("\n").filter(Boolean)) {
        logger.info(`  - ${file}`);
      }
      logger.info(`[DRY RUN] Commit message: ${message}`);

      await exec("git", ["reset", "HEAD"], { silent: true });

      core.setOutput("committed", "false");
      core.setOutput("sha", "");
      return;
    }

    await exec("git", ["commit", "-m", message]);
    logger.info("Changes committed");

    const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "develop";

    const pushExitCode = await exec("git", ["push", "origin", branch], {
      ignoreReturnCode: true,
    });

    if (pushExitCode !== 0) {
      logger.info("Direct push failed, attempting fetch and rebase");

      const isShallow = await execGit(["rev-parse", "--is-shallow-repository"]);
      if (isShallow === "true") {
        await exec("git", ["fetch", "--deepen=50", "origin", branch], {
          ignoreReturnCode: true,
        });
      } else {
        await exec("git", ["fetch", "origin", branch], { silent: true });
      }

      await exec("git", ["rebase", `origin/${branch}`]);
      await exec("git", ["push", "origin", branch]);
    }

    logger.info("Changes pushed");

    const sha = await execGit(["rev-parse", "HEAD"]);

    core.setOutput("committed", "true");
    core.setOutput("sha", sha);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
