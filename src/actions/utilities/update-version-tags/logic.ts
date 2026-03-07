/**
 * Update Version Tags Logic
 *
 * Updates Git tags for releases:
 * - Major version tags (v1, v2, etc.) for stable releases - useful for GitHub Actions
 * - Beta tag for prerelease versions
 */

import * as core from "@actions/core";
import { exec } from "@actions/exec";
import { Logger } from "../../../core/index.js";

const logger = new Logger({ prefix: "update-version-tags" });

export type TagType = "major" | "beta" | "both";

export function getMajorVersion(version: string): string {
  const major = version.replace(/^v/, "").split(".")[0];
  return `v${major}`;
}

export function isBetaVersion(version: string): boolean {
  return version.includes("-beta") || version.includes("-alpha") || version.includes("-rc");
}

export async function updateTag(tagName: string, message: string, targetRef?: string): Promise<void> {
  await exec("git", ["tag", "-d", tagName], { ignoreReturnCode: true, silent: true });

  const tagArgs = ["tag", "-fa", tagName, "-m", message];
  if (targetRef) {
    tagArgs.push(targetRef);
  }
  await exec("git", tagArgs);

  await exec("git", ["push", "origin", tagName, "--force"]);

  logger.info(`Updated tag: ${tagName}${targetRef ? ` -> ${targetRef}` : ""}`);
}

export async function run(): Promise<void> {
  try {
    const version = core.getInput("version", { required: true });
    const tagType = (core.getInput("tag_type") || "auto") as TagType | "auto";
    const dryRun = core.getBooleanInput("dry_run");

    const cleanVersion = version.startsWith("v") ? version : `v${version}`;
    const isBeta = isBetaVersion(cleanVersion);
    const majorTag = getMajorVersion(cleanVersion);

    logger.info("Updating version tags", {
      version: cleanVersion,
      tagType,
      isBeta,
      majorTag,
      dryRun,
    });

    let updateMajor = false;
    let updateBeta = false;

    if (tagType === "auto") {
      updateBeta = isBeta;
      updateMajor = !isBeta;
    } else if (tagType === "major") {
      updateMajor = true;
    } else if (tagType === "beta") {
      updateBeta = true;
    } else if (tagType === "both") {
      updateMajor = true;
      updateBeta = true;
    }

    const updatedTags: string[] = [];

    if (dryRun) {
      core.info(
        `[DRY RUN] Would update tags: major=${updateMajor ? majorTag : "no"}, beta=${updateBeta ? "yes" : "no"}`,
      );
      core.setOutput("updated_tags", "");
      core.setOutput("major_tag", "");
      core.setOutput("is_beta", isBeta.toString());
      return;
    }

    if (updateMajor) {
      await updateTag(majorTag, `Update ${majorTag} to ${cleanVersion}`, cleanVersion);
      updatedTags.push(majorTag);
    }

    if (updateBeta) {
      await updateTag("beta", `Update beta tag to ${cleanVersion}`, cleanVersion);
      updatedTags.push("beta");
    }

    core.setOutput("updated_tags", updatedTags.join(","));
    core.setOutput("major_tag", updateMajor ? majorTag : "");
    core.setOutput("is_beta", isBeta.toString());
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed("An unexpected error occurred");
    }
  }
}
