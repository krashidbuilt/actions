/**
 * Generate action.yml files from ActionConfig definitions
 *
 * This script imports config.ts from each action and generates the corresponding action.yml.
 * The configs are the single source of truth for action inputs/outputs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";
// Import all action configs from source
import { config as deployBuildBinaryConfig } from "../src/actions/deploy/build-binary/config.js";
import { config as deployFrontendConfig } from "../src/actions/deploy/frontend/config.js";
import { config as deployFrontendArtifactConfig } from "../src/actions/deploy/frontend-artifact/config.js";
import { config as deployInvalidateCacheConfig } from "../src/actions/deploy/invalidate-cache/config.js";
import { config as deployRollbackFrontendConfig } from "../src/actions/deploy/rollback-frontend/config.js";
import { config as typescriptInstallDependenciesConfig } from "../src/actions/typescript/install-dependencies/config.js";
import { config as typescriptPublishConfig } from "../src/actions/typescript/publish/config.js";
import { config as typescriptSetupConfig } from "../src/actions/typescript/setup/config.js";
import { config as typescriptVerifyConfig } from "../src/actions/typescript/verify/config.js";
import { config as commitArtifactsConfig } from "../src/actions/utilities/commit-artifacts/config.js";
import { config as configureAwsConfig } from "../src/actions/utilities/configure-aws/config.js";
import { config as detectAppInfoConfig } from "../src/actions/utilities/detect-app-info/config.js";
import { config as detectEnvironmentConfig } from "../src/actions/utilities/detect-environment/config.js";
import { config as mergeBranchConfig } from "../src/actions/utilities/merge-branch/config.js";
import { config as parseVersionConfig } from "../src/actions/utilities/parse-version/config.js";
import { config as slackNotifyConfig } from "../src/actions/utilities/slack-notify/config.js";
import { config as syncBranchesConfig } from "../src/actions/utilities/sync-branches/config.js";
import { config as triggerWorkflowConfig } from "../src/actions/utilities/trigger-workflow/config.js";
import { config as updateVersionTagsConfig } from "../src/actions/utilities/update-version-tags/config.js";
import { config as versioningConfig } from "../src/actions/versioning/config.js";
import { getOutputPath } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

export interface ActionConfigShape {
  name: string;
  description: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  runs: { using: string; main: string };
}

/**
 * Map of action source paths to their configs
 */
export const actionConfigs: Record<string, ActionConfigShape> = {
  // Versioning
  versioning: versioningConfig,

  // TypeScript actions
  "typescript/setup": typescriptSetupConfig,
  "typescript/install-dependencies": typescriptInstallDependenciesConfig,
  "typescript/verify": typescriptVerifyConfig,
  "typescript/publish": typescriptPublishConfig,

  // Deploy actions
  "deploy/frontend": deployFrontendConfig,
  "deploy/frontend-artifact": deployFrontendArtifactConfig,
  "deploy/invalidate-cache": deployInvalidateCacheConfig,
  "deploy/rollback-frontend": deployRollbackFrontendConfig,
  "deploy/build-binary": deployBuildBinaryConfig,

  // Utility actions
  "utilities/configure-aws": configureAwsConfig,
  "utilities/detect-environment": detectEnvironmentConfig,
  "utilities/detect-app-info": detectAppInfoConfig,
  "utilities/commit-artifacts": commitArtifactsConfig,
  "utilities/parse-version": parseVersionConfig,
  "utilities/update-version-tags": updateVersionTagsConfig,
  "utilities/sync-branches": syncBranchesConfig,
  "utilities/merge-branch": mergeBranchConfig,
  "utilities/trigger-workflow": triggerWorkflowConfig,
  "utilities/slack-notify": slackNotifyConfig,
};

export { getOutputPath } from "./utils.js";

/**
 * Generate action.yml content from config
 */
export function generateActionYml(config: ActionConfigShape): string {
  const doc: Record<string, unknown> = {
    name: config.name,
    description: config.description,
  };

  if (config.inputs && Object.keys(config.inputs).length > 0) {
    doc.inputs = config.inputs;
  }

  if (config.outputs && Object.keys(config.outputs).length > 0) {
    doc.outputs = config.outputs;
  }

  doc.runs = config.runs;

  return yaml.stringify(doc, {
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
}

function main(): void {
  console.log("Generating action.yml files from configs...\n");

  for (const [sourcePath, config] of Object.entries(actionConfigs)) {
    const outputPath = getOutputPath(sourcePath);
    const actionDir = resolve(rootDir, outputPath);
    const ymlPath = resolve(actionDir, "action.yml");

    mkdirSync(actionDir, { recursive: true });

    const content = generateActionYml(config);
    writeFileSync(ymlPath, content);
    console.log(`  ${outputPath}/action.yml`);
  }

  console.log("\nAll action.yml files generated!");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("generate-action-ymls.ts")) {
  main();
}
