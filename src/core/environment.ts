/**
 * Environment detection utilities
 * Detects the deployment environment from GitHub ref or explicit configuration
 */

import * as core from "@actions/core";
import { ORG } from "./constants.js";
import { getEnv, github } from "./env.js";
import { Logger } from "./logger.js";
import { type Environment, VALID_ENVIRONMENTS } from "./types.js";

const logger = new Logger({ prefix: "environment" });

export function isValidEnvironment(value: string): value is Environment {
  return VALID_ENVIRONMENTS.includes(value as Environment);
}

/**
 * Map branch names to environments
 * develop -> alpha, staging -> beta, production/main -> production
 */
const BRANCH_ENVIRONMENT_MAP: Record<string, Environment> = {
  develop: "alpha",
  staging: "beta",
  production: "production",
  main: "production",
};

export function detectEnvironmentFromRef(githubRef: string): Environment | null {
  logger.debug("Detecting environment from ref", { githubRef });

  if (githubRef.startsWith("refs/heads/")) {
    const branchName = githubRef.replace("refs/heads/", "");
    logger.debug("Extracted branch name", { branchName });

    const mappedEnv = BRANCH_ENVIRONMENT_MAP[branchName];
    if (mappedEnv) {
      return mappedEnv;
    }
  }

  if (githubRef.startsWith("refs/tags/")) {
    logger.debug("Detected tag ref, defaulting to production");
    return "production";
  }

  return null;
}

export interface DetectEnvironmentOptions {
  explicitEnvironment?: string;
  githubRef?: string;
  defaultEnvironment?: string;
}

export function detectEnvironment(options: DetectEnvironmentOptions = {}): Environment {
  const { explicitEnvironment, githubRef = github.getRefForEnvironment() || "", defaultEnvironment } = options;

  logger.debug("Detecting environment", options);

  if (explicitEnvironment) {
    if (isValidEnvironment(explicitEnvironment)) {
      logger.info(`Using explicit environment: ${explicitEnvironment}`);
      return explicitEnvironment;
    }
    throw new Error(`Invalid environment "${explicitEnvironment}". Valid values: ${VALID_ENVIRONMENTS.join(", ")}`);
  }

  const detectedEnv = detectEnvironmentFromRef(githubRef);
  if (detectedEnv) {
    logger.info(`Detected environment from ref: ${detectedEnv}`);
    return detectedEnv;
  }

  if (defaultEnvironment) {
    if (isValidEnvironment(defaultEnvironment)) {
      logger.info(`Using default environment: ${defaultEnvironment}`);
      return defaultEnvironment;
    }
    throw new Error(
      `Invalid default environment "${defaultEnvironment}". Valid values: ${VALID_ENVIRONMENTS.join(", ")}`,
    );
  }

  throw new Error(
    `Unable to detect environment from ref "${githubRef}". ` +
      "Please provide an explicit environment or use a recognized branch name.",
  );
}

export function getEnvironmentFromInputs(): Environment {
  const explicitEnvironment = core.getInput("environment");
  const githubRef = github.getRefForEnvironment() || core.getInput("GITHUB_REF");
  const defaultEnvironment = getEnv("DEFAULT_ENVIRONMENT") || core.getInput("default_environment");

  return detectEnvironment({
    explicitEnvironment: explicitEnvironment || undefined,
    githubRef: githubRef || undefined,
    defaultEnvironment: defaultEnvironment || undefined,
  });
}

/**
 * Get domain for environment
 * alpha -> alpha.krashidbuilt.com
 * beta -> beta.krashidbuilt.com
 * production -> krashidbuilt.com
 *
 * When a custom domain is provided, it is used instead of the org default.
 */
export function getDomain(environment: Environment, domain?: string): string {
  const baseDomain = domain || ORG.DOMAIN;
  switch (environment) {
    case "production":
      return baseDomain;
    case "alpha":
      return `alpha.${baseDomain}`;
    case "beta":
      return `beta.${baseDomain}`;
  }
}

export function getProfile(environment: Environment): string {
  switch (environment) {
    case "production":
      return "production";
    case "beta":
      return "staging";
    case "alpha":
      return "preview";
  }
}
