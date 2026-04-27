/**
 * AWS credentials. Two paths:
 * 1. Static — AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in env (Gitea, or any
 *    runner where long-lived keys are passed via secrets). Used directly.
 * 2. OIDC — assume role via GitHub Actions OIDC token. Falls back here when
 *    no static creds are present.
 */

import * as core from "@actions/core";
import { AWS } from "./constants.js";
import { getEnv } from "./env.js";
import { Logger } from "./logger.js";
import type { AwsConfig, AwsCredentials, Environment } from "./types.js";

const logger = new Logger({ prefix: "aws-credentials" });

const STS_ENDPOINT = "https://sts.amazonaws.com";

/**
 * Resolve the IAM role ARN from action input or environment variable.
 */
export function resolveRoleArn(): string {
  const fromInput = core.getInput("role_arn");
  if (fromInput) return fromInput;

  const fromEnv = getEnv("AWS_ROLE_ARN");
  if (fromEnv) return fromEnv;

  throw new Error("AWS role ARN not found. Provide role_arn input or set AWS_ROLE_ARN environment variable.");
}

/**
 * Assume an IAM role using GitHub Actions OIDC token.
 * Calls STS AssumeRoleWithWebIdentity directly via fetch (no SDK dependency).
 */
export async function assumeRoleWithOidc(roleArn: string): Promise<AwsCredentials> {
  logger.info("Requesting OIDC token from GitHub Actions...");
  const idToken = await core.getIDToken("sts.amazonaws.com");

  logger.info("Assuming role via STS AssumeRoleWithWebIdentity...");
  const params = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: "github-actions",
    WebIdentityToken: idToken,
  });

  const response = await fetch(STS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`STS AssumeRoleWithWebIdentity failed (${response.status}): ${text}`);
  }

  const accessKeyId = extractXmlValue(text, "AccessKeyId");
  const secretAccessKey = extractXmlValue(text, "SecretAccessKey");
  const sessionToken = extractXmlValue(text, "SessionToken");

  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error("STS response missing credential fields");
  }

  core.setSecret(secretAccessKey);
  core.setSecret(sessionToken);

  logger.info("Successfully assumed role via OIDC");

  return { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Extract a value from an XML element by tag name.
 */
function extractXmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>(.+?)</${tag}>`));
  return match?.[1];
}

/**
 * Get full AWS config. Prefers static credentials in env (Gitea path); else
 * falls back to OIDC role assumption (GitHub path).
 */
export async function getAwsConfig(environment: Environment, region?: string): Promise<AwsConfig> {
  const awsRegion = region || core.getInput("AWS_REGION") || getEnv("AWS_REGION") || AWS.REGION;

  const staticAccessKeyId = getEnv("AWS_ACCESS_KEY_ID");
  const staticSecretAccessKey = getEnv("AWS_SECRET_ACCESS_KEY");
  if (staticAccessKeyId && staticSecretAccessKey) {
    logger.info("Using static AWS credentials from environment");
    core.setSecret(staticSecretAccessKey);
    const staticSessionToken = getEnv("AWS_SESSION_TOKEN");
    if (staticSessionToken) core.setSecret(staticSessionToken);
    return {
      region: awsRegion,
      credentials: {
        accessKeyId: staticAccessKeyId,
        secretAccessKey: staticSecretAccessKey,
        ...(staticSessionToken ? { sessionToken: staticSessionToken } : {}),
      },
      environment,
    };
  }

  const roleArn = resolveRoleArn();
  const credentials = await assumeRoleWithOidc(roleArn);

  return {
    region: awsRegion,
    credentials,
    environment,
  };
}

/**
 * Export AWS credentials as environment variables for downstream steps.
 */
export function exportAwsCredentials(config: AwsConfig): void {
  logger.info(`Configuring AWS credentials for ${config.environment}`);

  core.exportVariable("AWS_ACCESS_KEY_ID", config.credentials.accessKeyId);
  core.exportVariable("AWS_SECRET_ACCESS_KEY", config.credentials.secretAccessKey);
  core.exportVariable("AWS_REGION", config.region);
  core.exportVariable("AWS_DEFAULT_REGION", config.region);

  if (config.credentials.sessionToken) {
    core.exportVariable("AWS_SESSION_TOKEN", config.credentials.sessionToken);
  }

  if (config.credentials.accountId) {
    core.exportVariable("AWS_ACCOUNT_ID", config.credentials.accountId);
  }
}
