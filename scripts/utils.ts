/**
 * Shared utilities for build scripts.
 */

/**
 * Map source action path to output directory.
 * Action categories live at the repo root (deploy/, typescript/, utilities/, versioning/).
 */
export function getOutputPath(actionPath: string): string {
  return actionPath;
}
