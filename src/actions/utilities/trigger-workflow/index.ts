/**
 * Trigger Workflow Action
 *
 * Triggers a GitHub Actions workflow in a repository for one or more branches.
 */

import * as core from "@actions/core";
import * as github from "@actions/github";
import { Logger } from "../../../core/index.js";

const logger = new Logger({ prefix: "trigger-workflow" });

async function run(): Promise<void> {
  try {
    const workflow = core.getInput("workflow", { required: true });
    const branchesInput = core.getInput("branches", { required: true });
    const githubToken = core.getInput("github_token", { required: true });
    const workflowInputs = core.getInput("inputs");

    let repository = core.getInput("repository");
    if (!repository) {
      repository = `${github.context.repo.owner}/${github.context.repo.repo}`;
    }

    const [owner, repo] = repository.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repository format: ${repository}. Expected 'owner/repo'`);
    }

    const branches = branchesInput
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    if (branches.length === 0) {
      throw new Error("No branches provided");
    }

    logger.info("Triggering workflow", {
      workflow,
      repository,
      branches,
      branchCount: branches.length,
    });

    const octokit = github.getOctokit(githubToken);

    let parsedInputs: Record<string, string> | undefined;
    if (workflowInputs) {
      try {
        parsedInputs = JSON.parse(workflowInputs);
      } catch (parseError) {
        throw new Error(`Invalid JSON in inputs parameter: ${parseError}`);
      }
    }

    const triggeredBranches: string[] = [];

    for (const branch of branches) {
      try {
        logger.info(`Triggering ${workflow} for ${branch} in ${repository}`);

        await octokit.rest.actions.createWorkflowDispatch({
          owner,
          repo,
          workflow_id: workflow,
          ref: branch,
          inputs: parsedInputs,
        });

        triggeredBranches.push(branch);
        logger.info(`Triggered ${workflow} for ${branch}`);
      } catch (error) {
        logger.error(`Failed to trigger ${workflow} for ${branch}`, error);
        throw error;
      }
    }

    core.setOutput("triggered_count", triggeredBranches.length.toString());
    core.setOutput("branches_triggered", triggeredBranches.join(","));

    logger.info("Successfully triggered workflows", {
      count: triggeredBranches.length,
      branches: triggeredBranches,
    });
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
