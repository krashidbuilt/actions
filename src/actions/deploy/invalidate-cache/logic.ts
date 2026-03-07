/**
 * Invalidate CloudFront Cache Logic
 *
 * Invalidates the CloudFront cache for a frontend application.
 * Useful for forcing cache refresh without a full deployment.
 */

import * as core from "@actions/core";
import {
  aws,
  type Environment,
  exportAwsCredentials,
  findApplicationBucket,
  findArtifactBucket,
  findDistributionId,
  getAwsConfig,
  invalidateCloudFront,
  Logger,
} from "../../../core/index.js";

const logger = new Logger({ prefix: "deploy/invalidate-cache" });

export interface InvalidateCacheInputs {
  environment: Environment;
  appName: string;
  paths: string;
  awsRegion: string;
}

export function getInputs(): InvalidateCacheInputs {
  const environment = core.getInput("environment", { required: true }) as Environment;
  const appName = core.getInput("app_name", { required: true });
  const paths = core.getInput("paths") || "/*";

  return {
    environment,
    appName,
    paths,
    awsRegion: aws.region(),
  };
}

/**
 * Parse the comma-separated paths string into an array of trimmed path strings.
 */
export function parsePaths(paths: string): string[] {
  return paths.split(",").map((p) => p.trim());
}

export async function run(): Promise<void> {
  const inputs = getInputs();

  try {
    logger.info("Starting CloudFront cache invalidation", {
      environment: inputs.environment,
      appName: inputs.appName,
      paths: inputs.paths,
    });

    // Configure AWS credentials
    const awsConfig = await getAwsConfig(inputs.environment, inputs.awsRegion);
    exportAwsCredentials(awsConfig);

    // Find artifact bucket first (needed to find application bucket)
    logger.info("Finding artifact bucket...");
    const artifactBucket = await findArtifactBucket();
    logger.info(`Artifact bucket: ${artifactBucket}`);

    // Find application bucket
    logger.info("Finding application bucket...");
    const applicationBucket = await findApplicationBucket(inputs.appName, inputs.environment);
    logger.info(`Application bucket: ${applicationBucket}`);

    // Find CloudFront distribution
    logger.info("Finding CloudFront distribution...");
    const distributionId = await findDistributionId(applicationBucket);
    logger.info(`CloudFront distribution: ${distributionId}`);

    // Invalidate CloudFront cache
    logger.info(`Invalidating paths: ${inputs.paths}`);
    const pathsArray = parsePaths(inputs.paths);
    const invalidationId = await invalidateCloudFront(distributionId, pathsArray);

    // Set outputs
    core.setOutput("invalidation_id", invalidationId);
    core.setOutput("distribution_id", distributionId);

    logger.info("CloudFront cache invalidation complete!", {
      invalidationId,
      distributionId,
    });
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
