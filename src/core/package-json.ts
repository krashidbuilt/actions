/**
 * Package.json reading utilities
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface PackageJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
}

export function readPackageJson(workingDirectory: string): PackageJson {
  const packageJsonPath = resolve(workingDirectory, "package.json");

  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }

  const content = readFileSync(packageJsonPath, "utf-8");
  return JSON.parse(content) as PackageJson;
}

export function tryReadPackageJson(workingDirectory: string): PackageJson | null {
  try {
    return readPackageJson(workingDirectory);
  } catch {
    return null;
  }
}

/**
 * Strip npm scope prefix from a package name.
 * e.g., "@krashidbuilt/ctrl" -> "ctrl"
 */
export function stripScope(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}
