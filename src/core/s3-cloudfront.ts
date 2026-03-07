/**
 * S3 and CloudFront utilities
 */

import * as exec from "@actions/exec";
import { getDomain } from "./environment.js";
import { Logger } from "./logger.js";
import type { Environment } from "./types.js";

const logger = new Logger({ prefix: "s3-cloudfront" });

export async function awsCli(args: string[]): Promise<string> {
  let stdout = "";
  await exec.exec("aws", args, {
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
    },
  });
  return stdout.trim();
}

/**
 * Find the artifact bucket (artifact.krashidbuilt.com or artifact.*.krashidbuilt.com)
 */
export async function findArtifactBucket(): Promise<string> {
  const output = await awsCli(["s3", "ls"]);
  const buckets = output.split("\n").map((line) => line.split(" ").pop() || "");
  const artifactBucket = buckets.find((bucket) => /^artifact\.(.+\.)?krashidbuilt\.com$/.test(bucket));

  if (!artifactBucket) {
    throw new Error("Could not find artifact bucket (artifact.*.krashidbuilt.com)");
  }

  return artifactBucket;
}

/**
 * Find the application bucket based on app name and environment.
 * Bucket naming: {app}.{domain} where domain is environment-aware
 * (e.g., ctrl.alpha.krashidbuilt.com, ctrl.krashidbuilt.com)
 */
export async function findApplicationBucket(
  appName: string,
  environment: Environment,
  domain?: string,
): Promise<string> {
  const resolvedDomain = getDomain(environment, domain);
  const appNameFirstPart = appName.split(".")[0];
  const applicationBucket = `${appNameFirstPart}.${resolvedDomain}`;

  const output = await awsCli(["s3", "ls"]);
  const buckets = output.split("\n").map((line) => line.split(" ").pop() || "");

  if (!buckets.includes(applicationBucket)) {
    throw new Error(`Application bucket does not exist: ${applicationBucket}`);
  }

  return applicationBucket;
}

/**
 * Find CloudFront distribution ID for a bucket
 */
export async function findDistributionId(applicationBucket: string): Promise<string> {
  const output = await awsCli(["cloudfront", "list-distributions"]);
  const distributions = JSON.parse(output);

  for (const dist of distributions.DistributionList?.Items || []) {
    const aliases = dist.Aliases?.Items || [];
    if (aliases.some((alias: string) => alias.includes(applicationBucket))) {
      return dist.Id;
    }
  }

  throw new Error(`Could not find CloudFront distribution for ${applicationBucket}`);
}

/**
 * Invalidate CloudFront distribution and wait for completion
 */
export async function invalidateCloudFront(distributionId: string, paths: string[] = ["/*"]): Promise<string> {
  logger.info(`Creating CloudFront invalidation for distribution ${distributionId}`);

  const output = await awsCli([
    "cloudfront",
    "create-invalidation",
    "--distribution-id",
    distributionId,
    "--paths",
    ...paths,
  ]);

  const invalidation = JSON.parse(output);
  const invalidationId = invalidation.Invalidation?.Id;

  if (!invalidationId) {
    throw new Error("Could not get invalidation ID");
  }

  logger.info(`Waiting for invalidation ${invalidationId} to complete...`);

  await exec.exec("aws", [
    "cloudfront",
    "wait",
    "invalidation-completed",
    "--distribution-id",
    distributionId,
    "--id",
    invalidationId,
  ]);

  logger.info("CloudFront invalidation completed");
  return invalidationId;
}

export async function checkArtifactVersionExists(
  artifactBucket: string,
  appName: string,
  version: string,
): Promise<boolean> {
  try {
    const path = `s3://${artifactBucket}/${appName}/${version}/`;
    await awsCli(["s3", "ls", path]);
    return true;
  } catch {
    return false;
  }
}

export async function syncFromArtifact(
  artifactBucket: string,
  appName: string,
  version: string,
  applicationBucket: string,
): Promise<void> {
  const source = `s3://${artifactBucket}/${appName}/${version}/`;
  const destination = `s3://${applicationBucket}/`;

  logger.info(`Syncing from ${source} to ${destination}`);
  await exec.exec("aws", ["s3", "sync", "--delete", source, destination]);
  logger.info("Sync completed");
}

export async function listArtifactVersions(artifactBucket: string, appName: string): Promise<string[]> {
  const path = `s3://${artifactBucket}/${appName}/`;
  const output = await awsCli(["s3", "ls", path]);

  const versions = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("PRE "))
    .map((line) => line.replace("PRE ", "").replace("/", ""))
    .filter((v) => v.length > 0);

  return versions.sort((a, b) => {
    const aParts = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
    const bParts = b.split(".").map((p) => Number.parseInt(p, 10) || 0);

    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (aVal !== bVal) return bVal - aVal;
    }
    return 0;
  });
}
