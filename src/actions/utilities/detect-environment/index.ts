/**
 * Detect Environment Action
 *
 * Detects the deployment environment from branch, tag, or explicit input.
 */

import * as core from "@actions/core";
import { common, detectEnvironment, getDomain, getProfile, github, Logger } from "../../../core/index.js";

const logger = new Logger({ prefix: "detect-environment" });

async function run(): Promise<void> {
  try {
    const explicitEnv = common.environment();
    const defaultEnv = core.getInput("default_environment") || "alpha";
    const githubRef = core.getInput("github_ref") || github.getRefForEnvironment() || "";

    logger.info("Detecting environment", {
      explicitEnv,
      defaultEnv,
      githubRef,
    });

    const environment = detectEnvironment({
      explicitEnvironment: explicitEnv,
      githubRef,
      defaultEnvironment: defaultEnv,
    });

    const isProduction = environment === "production";
    const isPrerelease = !isProduction;
    const domain = getDomain(environment);
    const profile = getProfile(environment);

    logger.info(`Detected environment: ${environment}`, {
      isProduction,
      isPrerelease,
      domain,
      profile,
    });

    core.setOutput("environment", environment);
    core.setOutput("is_production", isProduction.toString());
    core.setOutput("is_prerelease", isPrerelease.toString());
    core.setOutput("domain", domain);
    core.setOutput("profile", profile);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}

run();
