#!/usr/bin/env tsx

/**
 * Bundle all actions using esbuild
 * This script finds all action entry points and bundles them into their respective dist directories
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getOutputPath } from "./utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, "..");
const SRC_ACTIONS_DIR = join(ROOT_DIR, "src", "actions");

export interface ActionEntry {
  name: string;
  entryPoint: string;
  outputFile: string;
}

export interface ActionConfig {
  name: string;
  entries: ActionEntry[];
  outputDir: string;
}

export { getOutputPath } from "./utils.js";

/**
 * Find all actions in a source directory
 */
export function findActions(srcActionsDir = SRC_ACTIONS_DIR, rootDir = ROOT_DIR): ActionConfig[] {
  const actions: ActionConfig[] = [];

  function scanDir(dir: string, prefix = ""): void {
    if (!existsSync(dir)) return;

    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.isDirectory()) {
        const actionDir = join(dir, entry.name);
        const actionPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        const mainEntryPoint = join(actionDir, "index.ts");
        if (existsSync(mainEntryPoint)) {
          const outputPath = getOutputPath(actionPath);
          const outputDir = join(rootDir, outputPath, "dist");
          const entries: ActionEntry[] = [
            {
              name: "index",
              entryPoint: mainEntryPoint,
              outputFile: join(outputDir, "index.js"),
            },
          ];

          actions.push({
            name: actionPath,
            entries,
            outputDir,
          });
        }

        scanDir(actionDir, actionPath);
      }
    }
  }

  scanDir(srcActionsDir);
  return actions;
}

async function bundleEntry(entry: ActionEntry): Promise<void> {
  await build({
    entryPoints: [entry.entryPoint],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: entry.outputFile,
    minify: true,
    sourcemap: false,
    treeShaking: true,
    external: [],
    banner: {
      js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
    },
    logLevel: "warning",
  });
}

async function bundleAction(action: ActionConfig): Promise<void> {
  const entryNames = action.entries.map((e) => e.name).join(", ");
  console.log(`Bundling ${action.name} (${entryNames})...`);

  try {
    await Promise.all(action.entries.map((entry) => bundleEntry(entry)));
    console.log(`  ${action.name} bundled successfully`);
  } catch (error) {
    console.error(`  Failed to bundle ${action.name}`);
    throw error;
  }
}

async function main(): Promise<void> {
  console.log("Finding actions to bundle...\n");

  const actions = findActions();

  if (actions.length === 0) {
    console.log("No actions found to bundle.");
    return;
  }

  console.log(`Found ${actions.length} action(s):\n`);
  for (const action of actions) {
    console.log(`  - ${action.name}`);
  }
  console.log("");

  await Promise.all(actions.map((action) => bundleAction(action)));

  console.log("\nAll actions bundled successfully!");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bundle-actions.ts")) {
  main().catch((error) => {
    console.error("Bundle failed:", error);
    process.exit(1);
  });
}
