/**
 * Frontend Deploy Action - Business Logic
 *
 * Deploys frontend applications to S3/CloudFront.
 * - Uploads built files to artifact bucket for versioned archival
 * - Syncs files to application bucket (live site)
 * - Invalidates CloudFront distribution
 * - Cleans up old assets (keeps last N versions)
 */

import { resolve } from "node:path";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import {
  aws,
  BUILD,
  build,
  common,
  detectEnvironment,
  type Environment,
  exportAwsCredentials,
  findApplicationBucket,
  findArtifactBucket,
  findDistributionId,
  getAwsConfig,
  getDomain,
  github,
  invalidateCloudFront,
  Logger,
  readPackageVersion,
  stripScope,
  tryReadPackageJson,
} from "../../../core/index.js";
import {
  deleteFilesInBatches,
  determineFilesToDelete,
  getAllFilesFromBucket,
  getFilesFromVersions,
  getLastNVersions,
} from "./cleanup.js";

const logger = new Logger({ prefix: "deploy/frontend" });

export interface FrontendDeployInputs {
  environment?: string;
  buildDirectory: string;
  workingDirectory: string;
  awsRegion: string;
  githubToken: string;
  domain?: string;
  appName?: string;
  version?: string;
  invalidateCache: boolean;
  invalidationPaths: string[];
  versionsToKeep: number;
}

export function getInputs(): FrontendDeployInputs {
  const pathsInput = core.getInput("invalidation_paths") || "/*";
  const invalidationPaths = pathsInput
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const versionsToKeep = Number.parseInt(core.getInput("versions_to_keep") || "3", 10);

  return {
    environment: common.environment(),
    buildDirectory: build.directory(),
    workingDirectory: common.workingDirectory(),
    awsRegion: aws.region(),
    githubToken: common.githubToken(),
    domain: core.getInput("domain") || undefined,
    appName: core.getInput("app_name") || undefined,
    version: core.getInput("version") || undefined,
    invalidateCache: core.getInput("invalidate_cache") === "true",
    invalidationPaths: invalidationPaths.length > 0 ? invalidationPaths : ["/*"],
    versionsToKeep: Number.isNaN(versionsToKeep) ? 3 : versionsToKeep,
  };
}

/**
 * Detect app name from package.json or directory
 */
export function detectAppName(workingDirectory: string): string {
  const pkg = tryReadPackageJson(workingDirectory);
  return pkg?.name ? stripScope(pkg.name) : BUILD.DEFAULT_FRONTEND_APP;
}

export async function run(): Promise<void> {
  let environment: Environment | undefined;
  let appName: string | undefined;
  let version: string | undefined;

  try {
    const inputs = getInputs();
    const workingDir = resolve(inputs.workingDirectory);
    const buildDir = resolve(workingDir, inputs.buildDirectory);

    // Detect environment
    environment = detectEnvironment({
      explicitEnvironment: inputs.environment,
      githubRef: github.getRefForEnvironment(),
    });

    // Detect app name and version
    appName = inputs.appName || detectAppName(workingDir);
    version = inputs.version || readPackageVersion(workingDir);

    // Artifact prefix: namespace by domain when using a custom domain to prevent collisions
    // e.g. "www" for default domain, "kauffman.ai/www" for custom domain
    const artifactPrefix = inputs.domain ? `${inputs.domain}/${appName}` : appName;

    logger.info("Starting frontend deployment", {
      environment,
      appName,
      version,
      buildDirectory: buildDir,
    });

    // Configure AWS credentials
    const awsConfig = await getAwsConfig(environment, inputs.awsRegion);
    exportAwsCredentials(awsConfig);

    // Set outputs
    core.setOutput("environment", environment);
    core.setOutput("version", version);
    core.setOutput("url", `https://${appName}.${getDomain(environment, inputs.domain)}`);

    // Step 1: Find artifact bucket
    logger.info("Finding artifact bucket...");
    const artifactBucket = await findArtifactBucket();
    logger.info(`Artifact bucket: ${artifactBucket}`);

    // Step 2: Find application bucket
    logger.info("Finding application bucket...");
    const applicationBucket = await findApplicationBucket(appName, environment, inputs.domain);
    logger.info(`Application bucket: ${applicationBucket}`);

    // Step 3: Upload to artifact bucket (versioned archive)
    logger.info(`Uploading to artifact bucket: s3://${artifactBucket}/${artifactPrefix}/${version}/`);
    await exec.exec("aws", [
      "s3",
      "cp",
      "--recursive",
      buildDir,
      `s3://${artifactBucket}/${artifactPrefix}/${version}`,
    ]);

    // Step 4: Sync to application bucket (live site)
    // DO NOT use --delete flag to prevent race condition white screens
    // Old assets will remain in S3 (minimal cost) but prevent 404s during cache propagation
    logger.info(`Syncing to application bucket: s3://${applicationBucket}/`);
    logger.info("Note: Old assets are kept to prevent white screens during CloudFront cache propagation");
    await exec.exec("aws", ["s3", "sync", buildDir, `s3://${applicationBucket}`]);

    // Step 5: Invalidate CloudFront cache AFTER syncing
    // This ensures new files are in place before cache is cleared
    const distributionId = await findDistributionId(applicationBucket);
    if (inputs.invalidateCache) {
      logger.info(`Invalidating CloudFront cache (paths: ${inputs.invalidationPaths.join(", ")})...`);
      await invalidateCloudFront(distributionId, inputs.invalidationPaths);
    } else {
      logger.info("Skipping CloudFront cache invalidation (invalidate_cache=false)");
    }

    // Step 6: Clean up old assets (keep last N deployed versions)
    // This prevents S3 from growing indefinitely while keeping recent versions for quick rollback
    logger.info(`Cleaning up old assets (keeping last ${inputs.versionsToKeep} versions)...`);
    try {
      const versionsToKeep = await getLastNVersions(artifactBucket, artifactPrefix, inputs.versionsToKeep, version);
      logger.info(`Keeping assets for versions: ${versionsToKeep.join(", ")}`);

      const filesToKeep = await getFilesFromVersions(artifactBucket, artifactPrefix, versionsToKeep);
      logger.info(`Found ${filesToKeep.size} unique files across last ${inputs.versionsToKeep} versions`);

      const allFiles = await getAllFilesFromBucket(applicationBucket);
      const filesToDelete = determineFilesToDelete(allFiles, filesToKeep);

      if (filesToDelete.length > 0) {
        logger.info(`Deleting ${filesToDelete.length} old asset files...`);
        await deleteFilesInBatches(applicationBucket, filesToDelete);
        logger.info(`Successfully cleaned up ${filesToDelete.length} old files`);
      } else {
        logger.info("No old files to clean up");
      }
    } catch (error) {
      // Don't fail deployment if cleanup fails
      logger.info(`Cleanup failed (non-critical): ${error instanceof Error ? error.message : error}`);
    }

    logger.info("Frontend deployment complete!");
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
