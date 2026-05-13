/**
 * Verify that all action bundles exist and are valid
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const defaultActionsDir = rootDir;

// Top-level dirs that are NOT action categories
const SKIP_DIRS = new Set([
  "node_modules",
  "coverage",
  "dist",
  "src",
  "scripts",
  ".gitea",
  ".github",
  ".git",
  ".husky",
  ".vscode",
]);

export interface ActionInfo {
  path: string;
  hasActionYml: boolean;
  hasDistIndex: boolean;
}

/**
 * Discover all actions at the repo root (deploy/, typescript/, utilities/, versioning/, etc.)
 */
export function discoverActions(actionsDir = defaultActionsDir): ActionInfo[] {
  const allActions: ActionInfo[] = [];

  if (!existsSync(actionsDir)) {
    return allActions;
  }

  const topLevel = readdirSync(actionsDir, { withFileTypes: true });

  for (const entry of topLevel) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".")) continue;

    const topPath = join(actionsDir, entry.name);
    const actionYmlPath = join(topPath, "action.yml");
    const distIndexPath = join(topPath, "dist", "index.js");

    if (existsSync(actionYmlPath)) {
      allActions.push({
        path: entry.name,
        hasActionYml: true,
        hasDistIndex: existsSync(distIndexPath),
      });
    }

    const subEntries = readdirSync(topPath, { withFileTypes: true });
    for (const subEntry of subEntries) {
      if (!subEntry.isDirectory() || subEntry.name === "dist") continue;

      const subPath = join(topPath, subEntry.name);
      const nestedActionYml = join(subPath, "action.yml");
      const nestedDistIndex = join(subPath, "dist", "index.js");

      if (existsSync(nestedActionYml)) {
        allActions.push({
          path: `${entry.name}/${subEntry.name}`,
          hasActionYml: true,
          hasDistIndex: existsSync(nestedDistIndex),
        });
      }
    }
  }

  return allActions;
}

/**
 * Syntax-check a JavaScript bundle using `node --check`.
 */
export function checkBundleSyntax(filePath: string): boolean {
  const result = spawnSync("node", ["--check", filePath], {
    stdio: "pipe",
    timeout: 10_000,
  });
  return result.status === 0;
}

function main(): void {
  console.log("Verifying action bundles...\n");

  const actions = discoverActions();
  let hasErrors = false;

  if (actions.length === 0) {
    console.error("::error::No actions found! Expected at least one action.");
    process.exit(1);
  }

  console.log(`Found ${actions.length} actions:\n`);

  for (const action of actions) {
    if (!action.hasActionYml) {
      console.error(`::error::Missing ${action.path}/action.yml`);
      hasErrors = true;
    } else if (!action.hasDistIndex) {
      console.error(`::error::Missing ${action.path}/dist/index.js`);
      hasErrors = true;
    } else {
      const distPath = join(defaultActionsDir, action.path, "dist", "index.js");
      if (!checkBundleSyntax(distPath)) {
        console.error(`::error::Bundle syntax check failed for ${action.path}/dist/index.js`);
        hasErrors = true;
      } else {
        console.log(`  ${action.path} OK`);
      }
    }
  }

  if (hasErrors) {
    console.error("\nBundle verification failed!");
    process.exit(1);
  }

  console.log("\nAll action bundles verified!");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify-bundles.ts")) {
  main();
}
