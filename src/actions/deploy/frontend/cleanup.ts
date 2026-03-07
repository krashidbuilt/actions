/**
 * Frontend Deployment Cleanup
 *
 * Removes stale files from the application bucket that are not present
 * in the last N deployed versions. Prevents S3 from growing indefinitely
 * while keeping recent versions for quick rollback.
 */

import * as exec from "@actions/exec";

/**
 * Extract the channel from a semver string.
 * "0.1.1-alpha.3" → "alpha", "0.1.1-beta.1" → "beta", "0.1.1" → "stable"
 */
function getChannel(version: string): string {
  const prerelease = version.split("-")[1];
  if (!prerelease) return "stable";
  return prerelease.split(".")[0];
}

/**
 * Compare two semver strings (same channel).
 * Returns negative if a < b, positive if a > b, 0 if equal.
 * Compares main version first, then prerelease number.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string): { main: number[]; pre: number } => {
    const [mainPart, prerelease] = v.split("-");
    const main = mainPart.split(".").map((n) => Number.parseInt(n, 10) || 0);
    const pre = prerelease ? Number.parseInt(prerelease.split(".").pop() || "0", 10) || 0 : Number.MAX_SAFE_INTEGER;
    return { main, pre };
  };

  const aParsed = parse(a);
  const bParsed = parse(b);

  const maxLen = Math.max(aParsed.main.length, bParsed.main.length);
  for (let i = 0; i < maxLen; i++) {
    const aVal = aParsed.main[i] || 0;
    const bVal = bParsed.main[i] || 0;
    if (aVal !== bVal) return aVal - bVal;
  }

  return aParsed.pre - bParsed.pre;
}

/**
 * Get the last N versions from the artifact bucket for the same channel as currentVersion.
 * e.g. if currentVersion is "0.1.1-beta.1", only considers other beta versions.
 */
export async function getLastNVersions(
  artifactBucket: string,
  appName: string,
  count: number,
  currentVersion: string,
): Promise<string[]> {
  const versionsOutput = await exec.getExecOutput("aws", [
    "s3api",
    "list-objects-v2",
    "--bucket",
    artifactBucket,
    "--prefix",
    `${appName}/`,
    "--delimiter",
    "/",
    "--query",
    "CommonPrefixes[*].Prefix",
    "--output",
    "json",
  ]);

  const channel = getChannel(currentVersion);
  const versionPrefixes = JSON.parse(versionsOutput.stdout || "[]");
  const versions = versionPrefixes
    .map((p: string) => p.replace(`${appName}/`, "").replace("/", ""))
    .filter((v: string) => v && getChannel(v) === channel)
    .sort((a: string, b: string) => compareSemver(b, a));

  return versions.slice(0, count);
}

/**
 * Get all files from specific versions in the artifact bucket.
 */
export async function getFilesFromVersions(
  artifactBucket: string,
  appName: string,
  versions: string[],
): Promise<Set<string>> {
  const filesToKeep = new Set<string>();

  for (const ver of versions) {
    const versionFilesOutput = await exec.getExecOutput("aws", [
      "s3api",
      "list-objects-v2",
      "--bucket",
      artifactBucket,
      "--prefix",
      `${appName}/${ver}/`,
      "--query",
      "Contents[*].Key",
      "--output",
      "json",
    ]);

    const versionFiles = JSON.parse(versionFilesOutput.stdout || "[]");
    for (const key of versionFiles) {
      const filePath = key.replace(`${appName}/${ver}/`, "");
      filesToKeep.add(filePath);
    }
  }

  return filesToKeep;
}

/**
 * Get all files from the application bucket.
 */
export async function getAllFilesFromBucket(bucket: string): Promise<string[]> {
  const appFilesOutput = await exec.getExecOutput("aws", [
    "s3api",
    "list-objects-v2",
    "--bucket",
    bucket,
    "--query",
    "Contents[*].Key",
    "--output",
    "json",
  ]);

  return JSON.parse(appFilesOutput.stdout || "[]");
}

/**
 * Determine which files should be deleted.
 * Never deletes critical files (index.html, robots.txt, favicon.ico, sitemap.xml, files starting with _).
 */
export function determineFilesToDelete(allFiles: string[], filesToKeep: Set<string>): string[] {
  const filesToDelete: string[] = [];

  for (const key of allFiles) {
    if (
      key === "index.html" ||
      key === "robots.txt" ||
      key === "favicon.ico" ||
      key === "sitemap.xml" ||
      key.startsWith("_")
    ) {
      continue;
    }

    if (!filesToKeep.has(key)) {
      filesToDelete.push(key);
    }
  }

  return filesToDelete;
}

/**
 * Delete files from S3 in batches (AWS limit is 1000 objects per delete request).
 */
export async function deleteFilesInBatches(bucket: string, files: string[]): Promise<void> {
  const batchSize = 1000;

  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const deleteJson = JSON.stringify({
      Objects: batch.map((key) => ({ Key: key })),
      Quiet: true,
    });
    await exec.exec("aws", ["s3api", "delete-objects", "--bucket", bucket, "--delete", deleteJson]);
  }
}
