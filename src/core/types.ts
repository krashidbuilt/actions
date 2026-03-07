/**
 * Core types used across all GitHub Actions
 */

/**
 * Supported deployment environments
 */
export type Environment = "alpha" | "beta" | "production";

/**
 * All valid environment values
 */
export const VALID_ENVIRONMENTS: readonly Environment[] = ["alpha", "beta", "production"] as const;

/**
 * Supported package managers for TypeScript projects
 */
export type PackageManager = "npm" | "yarn" | "bun";

/**
 * AWS credentials for a specific environment
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  accountId?: string;
}

/**
 * AWS configuration including region and credentials
 */
export interface AwsConfig {
  region: string;
  credentials: AwsCredentials;
  environment: Environment;
}

/**
 * Package manager detection result
 */
export interface PackageManagerInfo {
  packageManager: PackageManager;
  hasLockfile: boolean;
  lockfilePath?: string;
  lockfileName?: string;
}

/**
 * Version bump types
 */
export type VersionBumpType = "patch" | "minor" | "major";

/**
 * Version information
 */
export interface VersionInfo {
  current: string;
  previous?: string;
  bumpType?: VersionBumpType;
  tag?: string;
  isPrerelease: boolean;
}

/**
 * Frontend deployment configuration (S3/CloudFront)
 */
export interface FrontendDeployConfig {
  buildDirectory: string;
  s3Bucket?: string;
  cloudfrontDistributionId?: string;
  environment: Environment;
}
