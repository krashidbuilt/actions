/**
 * AWS credentials. Three auth paths:
 *
 *   1. Static-only — `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` in env, no
 *      `role_arn` requested. Used directly. Common in legacy GitHub workflows
 *      with broad-permission keys.
 *
 *   2. AssumeRole-by-deployer (Gitea canonical path) — long-lived deployer
 *      key in env + `role_arn` (or `aws_account_id` + `role_scope`) supplied
 *      as input. Deployer key signs an STS AssumeRole call (SigV4) to mint
 *      short-lived per-env role credentials. Used for Gitea-hosted consumers
 *      that cannot use OIDC workload-identity tokens (Gitea Actions does not
 *      yet emit them — see Gitea issue #33681).
 *
 *   3. OIDC AssumeRoleWithWebIdentity (GitHub canonical path) — no static
 *      creds in env, `role_arn` supplied. GitHub Actions OIDC token (audience
 *      `sts.amazonaws.com`) is exchanged at STS for short-lived role creds.
 *
 * Resolution precedence in `getAwsConfig`:
 *
 *   role_arn present? ──┬── static creds present? ──→ path 2 (deployer-key)
 *                       └── no static creds       ──→ path 3 (OIDC)
 *   role_arn absent  ──┬── static creds present? ──→ path 1 (static-only)
 *                      └── no static creds       ──→ throw
 */

import * as core from "@actions/core";
import { signRequest } from "./aws-sigv4.js";
import { AWS } from "./constants.js";
import { getEnv } from "./env.js";
import { Logger } from "./logger.js";
import type { AwsConfig, AwsCredentials, Environment } from "./types.js";

const logger = new Logger({ prefix: "aws-credentials" });

const STS_HOST = "sts.amazonaws.com";
const STS_ENDPOINT = `https://${STS_HOST}/`;
const STS_REGION = "us-east-1";

const DEFAULT_SESSION_DURATION = 3600;
const MIN_SESSION_DURATION = 900;
const MAX_SESSION_DURATION = 43200;

/**
 * Resolve the IAM role ARN from inputs / env. Returns `undefined` when no
 * role is requested (static-only path).
 *
 * Sources (in order):
 *   1. `role_arn` action input (direct ARN)
 *   2. `aws_account_id` + `role_scope` inputs → constructs
 *      `arn:aws:iam::<account>:role/deploy-<scope>` (matches plan v6)
 *   3. `AWS_ROLE_ARN` env var
 */
export function resolveRoleArn(): string | undefined {
  const fromInput = core.getInput("role_arn");
  if (fromInput) return fromInput;

  const accountId = core.getInput("aws_account_id");
  const roleScope = core.getInput("role_scope");
  if (accountId && roleScope) {
    return `arn:aws:iam::${accountId}:role/deploy-${roleScope}`;
  }

  const fromEnv = getEnv("AWS_ROLE_ARN");
  if (fromEnv) return fromEnv;

  return undefined;
}

/**
 * Resolve session duration in seconds. Default 3600 (1h), AWS-allowed range
 * 900–43200. Throws on invalid values rather than silently clamping.
 */
export function resolveSessionDuration(): number {
  const fromInput = core.getInput("session_duration");
  if (!fromInput) return DEFAULT_SESSION_DURATION;

  const n = Number.parseInt(fromInput, 10);
  if (Number.isNaN(n) || n < MIN_SESSION_DURATION || n > MAX_SESSION_DURATION) {
    throw new Error(
      `Invalid session_duration "${fromInput}": must be an integer between ${MIN_SESSION_DURATION} and ${MAX_SESSION_DURATION} seconds.`,
    );
  }
  return n;
}

interface AssumeRoleOptions {
  sessionDuration?: number;
  sessionName?: string;
  region?: string;
}

/**
 * Path 3 — Assume an IAM role using GitHub Actions OIDC token.
 * Calls STS `AssumeRoleWithWebIdentity` directly via fetch (no SigV4 needed —
 * the OIDC bearer token is the credential).
 */
export async function assumeRoleWithOidc(roleArn: string, options: AssumeRoleOptions = {}): Promise<AwsCredentials> {
  const sessionDuration = options.sessionDuration ?? DEFAULT_SESSION_DURATION;
  const sessionName = options.sessionName ?? "github-actions";

  logger.info("Requesting OIDC token from GitHub Actions...");
  const idToken = await core.getIDToken("sts.amazonaws.com");

  logger.info(`Assuming role via STS AssumeRoleWithWebIdentity (duration=${sessionDuration}s)...`);
  const params = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    WebIdentityToken: idToken,
    DurationSeconds: String(sessionDuration),
  });

  const response = await fetch(STS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  return parseStsCredentialsResponse(response, "AssumeRoleWithWebIdentity");
}

/**
 * Path 2 — Assume an IAM role using a long-lived deployer access key.
 * Signs the STS `AssumeRole` request with SigV4 using the deployer's keys.
 *
 * The deployer user is expected to have a tightly-scoped trust policy:
 * `sts:AssumeRole` only on the per-env `deploy-app` / `deploy-infra` roles
 * in its env-account. A leaked deployer key cannot reach other envs.
 */
export async function assumeRoleWithDeployerKey(
  roleArn: string,
  deployerCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  options: AssumeRoleOptions = {},
): Promise<AwsCredentials> {
  const sessionDuration = options.sessionDuration ?? DEFAULT_SESSION_DURATION;
  const sessionName = options.sessionName ?? "gitea-actions";
  const region = options.region ?? STS_REGION;

  logger.info(`Assuming role via STS AssumeRole using deployer key (duration=${sessionDuration}s)...`);

  const body = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: roleArn,
    RoleSessionName: sessionName,
    DurationSeconds: String(sessionDuration),
  }).toString();

  const signed = signRequest({
    method: "POST",
    url: STS_ENDPOINT,
    region,
    service: "sts",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    credentials: deployerCredentials,
  });

  const response = await fetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
  });

  return parseStsCredentialsResponse(response, "AssumeRole");
}

async function parseStsCredentialsResponse(response: Response, apiName: string): Promise<AwsCredentials> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`STS ${apiName} failed (${response.status}): ${text}`);
  }

  const accessKeyId = extractXmlValue(text, "AccessKeyId");
  const secretAccessKey = extractXmlValue(text, "SecretAccessKey");
  const sessionToken = extractXmlValue(text, "SessionToken");

  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error("STS response missing credential fields");
  }

  core.setSecret(secretAccessKey);
  core.setSecret(sessionToken);

  logger.info(`Successfully assumed role via ${apiName}`);

  return { accessKeyId, secretAccessKey, sessionToken };
}

function extractXmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>(.+?)</${tag}>`));
  return match?.[1];
}

/**
 * Resolve full AWS credentials per the precedence rules at the top of this file.
 */
export async function getAwsConfig(environment: Environment, region?: string): Promise<AwsConfig> {
  const awsRegion = region || core.getInput("aws_region") || getEnv("AWS_REGION") || AWS.REGION;
  const roleArn = resolveRoleArn();
  const sessionDuration = resolveSessionDuration();

  const staticAccessKeyId = getEnv("AWS_ACCESS_KEY_ID");
  const staticSecretAccessKey = getEnv("AWS_SECRET_ACCESS_KEY");
  const staticSessionToken = getEnv("AWS_SESSION_TOKEN");
  const hasStaticCreds = !!(staticAccessKeyId && staticSecretAccessKey);

  if (roleArn) {
    if (hasStaticCreds) {
      logger.info("Auth path: AssumeRole-by-deployer (static deployer key + role_arn)");
      core.setSecret(staticSecretAccessKey);
      if (staticSessionToken) core.setSecret(staticSessionToken);
      const credentials = await assumeRoleWithDeployerKey(
        roleArn,
        {
          accessKeyId: staticAccessKeyId,
          secretAccessKey: staticSecretAccessKey,
          ...(staticSessionToken ? { sessionToken: staticSessionToken } : {}),
        },
        { region: awsRegion, sessionDuration, sessionName: `gitea-actions-${environment}` },
      );
      return { region: awsRegion, credentials, environment };
    }
    logger.info("Auth path: OIDC AssumeRoleWithWebIdentity (no static creds + role_arn)");
    const credentials = await assumeRoleWithOidc(roleArn, {
      sessionDuration,
      sessionName: `github-actions-${environment}`,
    });
    return { region: awsRegion, credentials, environment };
  }

  if (!hasStaticCreds) {
    throw new Error(
      "No AWS credentials available. Provide one of: " +
        "(a) role_arn input + AWS_ACCESS_KEY_ID/SECRET in env (deployer path); " +
        "(b) role_arn input on a runner with GitHub OIDC (id-token: write); " +
        "(c) AWS_ACCESS_KEY_ID/SECRET in env (static-only path); " +
        "or set AWS_ROLE_ARN env var.",
    );
  }

  logger.info("Auth path: static credentials from environment");
  core.setSecret(staticSecretAccessKey);
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
