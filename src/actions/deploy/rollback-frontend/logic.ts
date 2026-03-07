/**
 * Frontend Rollback Logic
 *
 * Rolls back a frontend to the previous version.
 * Lists versions in artifact bucket, sorted by semver, deploys the second one.
 */

import * as core from "@actions/core";
import {
  common,
  type Environment,
  exportAwsCredentials,
  findApplicationBucket,
  findArtifactBucket,
  findDistributionId,
  getAwsConfig,
  invalidateCloudFront,
  isValidEnvironment,
  Logger,
  listArtifactVersions,
  syncFromArtifact,
  VALID_ENVIRONMENTS,
} from "../../../core/index.js";

const logger = new Logger({ prefix: "deploy/rollback-frontend" });

/**
 * Determine whether to invalidate CloudFront cache.
 * Always invalidates for non-production environments; respects the input for production.
 */
export function shouldInvalidateCache(environment: Environment, invalidateCacheInput: boolean): boolean {
  return environment !== "production" || invalidateCacheInput;
}

export async function run(): Promise<void> {
  try {
    const environmentInput = common.environment();
    if (!environmentInput) {
      throw new Error("environment input is required");
    }
    if (!isValidEnvironment(environmentInput)) {
      throw new Error(`Invalid environment "${environmentInput}". Valid values: ${VALID_ENVIRONMENTS.join(", ")}`);
    }
    const environment = environmentInput;

    const appName = core.getInput("app_name", { required: true });
    const invalidateCache = core.getInput("invalidate_cache") !== "false";

    logger.info(`Starting rollback for ${appName} in ${environment}`);

    // Configure AWS
    const awsConfig = await getAwsConfig(environment);
    exportAwsCredentials(awsConfig);

    // Find buckets
    const artifactBucket = await findArtifactBucket();
    logger.info(`Artifact bucket: ${artifactBucket}`);

    const applicationBucket = await findApplicationBucket(appName, environment);
    logger.info(`Application bucket: ${applicationBucket}`);

    // List versions (sorted newest first by semver)
    const versions = await listArtifactVersions(artifactBucket, appName);
    logger.info(
      `Found ${versions.length} versions: ${versions.slice(0, 5).join(", ")}${versions.length > 5 ? "..." : ""}`,
    );

    if (versions.length < 2) {
      throw new Error("Need at least 2 versions to rollback");
    }

    // Latest = current, second = previous
    const currentVersion = versions[0];
    const previousVersion = versions[1];

    logger.info(`Rolling back: ${currentVersion} -> ${previousVersion}`);

    // Sync previous version to app bucket
    await syncFromArtifact(artifactBucket, appName, previousVersion, applicationBucket);

    // Invalidate CloudFront
    // Always invalidate for alpha/beta, respect input for production
    if (shouldInvalidateCache(environment, invalidateCache)) {
      const distributionId = await findDistributionId(applicationBucket);
      await invalidateCloudFront(distributionId);
    }

    // Set outputs
    core.setOutput("current_version", currentVersion);
    core.setOutput("rolled_back_to", previousVersion);

    logger.info(`Rolled back to ${previousVersion}`);
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
