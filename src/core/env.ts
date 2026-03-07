/**
 * Environment variable access utilities
 */

export type GitHubEnvVar =
  | "GITHUB_TOKEN"
  | "GITHUB_REF"
  | "GITHUB_SHA"
  | "GITHUB_REPOSITORY"
  | "GITHUB_RUN_ID"
  | "GITHUB_RUN_NUMBER"
  | "GITHUB_ACTOR"
  | "GITHUB_WORKFLOW"
  | "GITHUB_JOB"
  | "GITHUB_EVENT_NAME"
  | "GITHUB_SERVER_URL"
  | "RUNNER_OS"
  | "RUNNER_ARCH";

export type AwsEnvVar =
  | "AWS_ACCESS_KEY_ID"
  | "AWS_SECRET_ACCESS_KEY"
  | "AWS_SESSION_TOKEN"
  | "AWS_REGION"
  | "AWS_DEFAULT_REGION"
  | "AWS_ACCOUNT_ID"
  | "AWS_ROLE_ARN";

export type RegistryEnvVar = "NODE_AUTH_TOKEN" | "BUN_AUTH_TOKEN";

export type KnownEnvVar = GitHubEnvVar | AwsEnvVar | RegistryEnvVar;

export function getEnv(name: KnownEnvVar | string): string | undefined {
  return process.env[name];
}

export function getEnvOrDefault(name: KnownEnvVar | string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

export function getRequiredEnv(name: KnownEnvVar | string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function hasEnv(name: KnownEnvVar | string): boolean {
  return process.env[name] !== undefined && process.env[name] !== "";
}

export function setEnv(name: KnownEnvVar | string, value: string): void {
  process.env[name] = value;
}

export const github = {
  getToken: (): string | undefined => getEnv("GITHUB_TOKEN"),
  getRef: (): string | undefined => getEnv("GITHUB_REF"),
  getHeadRef: (): string | undefined => getEnv("GITHUB_HEAD_REF"),

  getRefForEnvironment: (): string | undefined => {
    const ref = getEnv("GITHUB_REF");
    if (ref?.startsWith("refs/pull/")) {
      const headRef = getEnv("GITHUB_HEAD_REF");
      return headRef ? `refs/heads/${headRef}` : undefined;
    }
    return ref;
  },

  getSha: (): string | undefined => getEnv("GITHUB_SHA"),
  getRepository: (): string | undefined => getEnv("GITHUB_REPOSITORY"),
  getRunId: (): string | undefined => getEnv("GITHUB_RUN_ID"),
  getActor: (): string | undefined => getEnv("GITHUB_ACTOR"),
  getRunnerOs: (): string => getEnvOrDefault("RUNNER_OS", "Linux"),
};
