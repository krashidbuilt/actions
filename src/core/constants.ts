/**
 * Centralized constants and default values
 */

/**
 * Organization constants
 */
export const ORG = {
  SCOPE: "@krashidbuilt",
  NAME: "krashidbuilt",
  DOMAIN: "krashidbuilt.com",
} as const;

/**
 * Runtime version defaults
 */
export const RUNTIME = {
  NODE_VERSION: "24",
  BUN_VERSION: "1.3.5",
} as const;

/**
 * AWS configuration defaults
 */
export const AWS = {
  REGION: "us-east-1",
} as const;

/**
 * NPM registry configuration defaults
 */
export const REGISTRY = {
  URL: "https://registry.npmjs.org/",
  SCOPE: ORG.SCOPE,
} as const;

/**
 * Infrastructure defaults
 */
export const INFRASTRUCTURE = {
  REPOSITORY: `${ORG.NAME}/infrastructure`,
} as const;

/**
 * Git defaults
 */
export const GIT = {
  USER_NAME: "github-actions[bot]",
  USER_EMAIL: "github-actions[bot]@users.noreply.github.com",
  PROTECTED_BRANCHES: ["main", "develop", "staging", "production"],
} as const;

/**
 * Build defaults
 */
export const BUILD = {
  DIRECTORY: "dist",
  DEFAULT_FRONTEND_APP: "frontend-app",
} as const;

/**
 * All defaults grouped for convenience
 */
export const DEFAULTS = {
  ORG,
  RUNTIME,
  AWS,
  REGISTRY,
  INFRASTRUCTURE,
  GIT,
  BUILD,
} as const;
