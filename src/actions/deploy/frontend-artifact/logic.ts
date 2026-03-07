/**
 * Frontend Artifact Deploy Logic
 *
 * Deploys a specific version from the artifact bucket to S3/CloudFront.
 * Used for rollbacks and promoting versions between environments.
 */

import * as core from "@actions/core";
import {
  aws,
  checkArtifactVersionExists,
  common,
  type Environment,
  exportAwsCredentials,
  findApplicationBucket,
  findArtifactBucket,
  findDistributionId,
  getAwsConfig,
  invalidateCloudFront,
  Logger,
  syncFromArtifact,
} from "../../../core/index.js";

const logger = new Logger({ prefix: "deploy/frontend-artifact" });

export interface FrontendArtifactDeployInputs {
  environment: Environment;
  version: string;
  appName: string;
  awsRegion: string;
  githubToken: string;
  invalidateCache: boolean;
}

export function getInputs(): FrontendArtifactDeployInputs {
  const environment = core.getInput("environment", { required: true }) as Environment;
  const version = core.getInput("version", { required: true });
  const appName = core.getInput("app_name", { required: true });
  const invalidateCache = core.getInput("invalidate_cache") === "true";

  return {
    environment,
    version,
    appName,
    awsRegion: aws.region(),
    githubToken: common.githubToken(),
    invalidateCache,
  };
}

export async function run(): Promise<void> {
  const inputs = getInputs();

  try {
    logger.info("Starting frontend artifact deployment", {
      environment: inputs.environment,
      appName: inputs.appName,
      version: inputs.version,
    });

    // Configure AWS credentials
    const awsConfig = await getAwsConfig(inputs.environment, inputs.awsRegion);
    exportAwsCredentials(awsConfig);

    // Set outputs
    core.setOutput("environment", inputs.environment);
    core.setOutput("version", inputs.version);
    core.setOutput("app_name", inputs.appName);

    // Step 1: Find artifact bucket
    logger.info("Finding artifact bucket...");
    const artifactBucket = await findArtifactBucket();
    logger.info(`Artifact bucket: ${artifactBucket}`);

    // Step 2: Check version exists
    logger.info(`Checking if version ${inputs.version} exists...`);
    const exists = await checkArtifactVersionExists(artifactBucket, inputs.appName, inputs.version);
    if (!exists) {
      throw new Error(`Version ${inputs.version} not found in artifact bucket for ${inputs.appName}`);
    }
    logger.info("Version found in artifact bucket");

    // Step 3: Find application bucket
    logger.info("Finding application bucket...");
    const applicationBucket = await findApplicationBucket(inputs.appName, inputs.environment);
    logger.info(`Application bucket: ${applicationBucket}`);

    // Step 4: Sync from artifact to application bucket
    logger.info("Syncing files...");
    await syncFromArtifact(artifactBucket, inputs.appName, inputs.version, applicationBucket);

    // Step 5: Invalidate CloudFront cache AFTER syncing
    if (inputs.invalidateCache) {
      logger.info("Invalidating CloudFront distribution...");
      const distributionId = await findDistributionId(applicationBucket);
      await invalidateCloudFront(distributionId);
    } else {
      logger.info("Skipping CloudFront cache invalidation (invalidate_cache=false)");
    }

    logger.info("Frontend artifact deployment complete!");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
