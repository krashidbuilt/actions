/**
 * Shared utilities for build scripts.
 */

/**
 * Map source action path to output directory.
 * All actions go under the actions/ directory.
 */
export function getOutputPath(actionPath: string): string {
  return `actions/${actionPath}`;
}
