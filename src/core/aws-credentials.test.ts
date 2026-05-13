import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetInput, mockSetSecret, mockExportVariable, mockGetIDToken } = vi.hoisted(() => ({
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => ""),
  mockSetSecret: vi.fn(),
  mockExportVariable: vi.fn(),
  mockGetIDToken: vi.fn(async (_audience?: string) => "mock-oidc-token"),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  setSecret: mockSetSecret,
  exportVariable: mockExportVariable,
  getIDToken: mockGetIDToken,
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  assumeRoleWithDeployerKey,
  assumeRoleWithOidc,
  exportAwsCredentials,
  getAwsConfig,
  resolveRoleArn,
  resolveSessionDuration,
} from "./aws-credentials.js";

const MOCK_OIDC_RESPONSE = `
<AssumeRoleWithWebIdentityResponse>
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>ASIA_OIDC</AccessKeyId>
      <SecretAccessKey>SECRET_OIDC</SecretAccessKey>
      <SessionToken>TOKEN_OIDC</SessionToken>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

const MOCK_ASSUMEROLE_RESPONSE = `
<AssumeRoleResponse>
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>ASIA_DEPLOYER</AccessKeyId>
      <SecretAccessKey>SECRET_DEPLOYER</SecretAccessKey>
      <SessionToken>TOKEN_DEPLOYER</SessionToken>
    </Credentials>
  </AssumeRoleResult>
</AssumeRoleResponse>`;

describe("resolveRoleArn", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockGetInput.mockReset();
    mockGetInput.mockReturnValue("");
  });

  it("resolves directly from role_arn input", () => {
    mockGetInput.mockImplementation((name: string) => (name === "role_arn" ? "arn:aws:iam::123:role/test" : ""));
    expect(resolveRoleArn()).toBe("arn:aws:iam::123:role/test");
  });

  it("constructs role ARN from aws_account_id + role_scope inputs", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "aws_account_id") return "999888777666";
      if (name === "role_scope") return "app";
      return "";
    });
    expect(resolveRoleArn()).toBe("arn:aws:iam::999888777666:role/deploy-app");
  });

  it("supports infra scope", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "aws_account_id") return "111222333444";
      if (name === "role_scope") return "infra";
      return "";
    });
    expect(resolveRoleArn()).toBe("arn:aws:iam::111222333444:role/deploy-infra");
  });

  it("prefers explicit role_arn over aws_account_id+role_scope", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "role_arn") return "arn:aws:iam::123:role/explicit";
      if (name === "aws_account_id") return "999";
      if (name === "role_scope") return "app";
      return "";
    });
    expect(resolveRoleArn()).toBe("arn:aws:iam::123:role/explicit");
  });

  it("falls back to AWS_ROLE_ARN environment variable", () => {
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::456:role/env");
    expect(resolveRoleArn()).toBe("arn:aws:iam::456:role/env");
  });

  it("returns undefined when nothing is set (static-only path)", () => {
    expect(resolveRoleArn()).toBeUndefined();
  });

  it("returns undefined when only aws_account_id is set without role_scope", () => {
    mockGetInput.mockImplementation((name: string) => (name === "aws_account_id" ? "999" : ""));
    expect(resolveRoleArn()).toBeUndefined();
  });
});

describe("resolveSessionDuration", () => {
  beforeEach(() => {
    mockGetInput.mockReset();
    mockGetInput.mockReturnValue("");
  });

  it("returns 3600 by default", () => {
    expect(resolveSessionDuration()).toBe(3600);
  });

  it("respects valid input value", () => {
    mockGetInput.mockImplementation((name: string) => (name === "session_duration" ? "1800" : ""));
    expect(resolveSessionDuration()).toBe(1800);
  });

  it("accepts the AWS minimum (900)", () => {
    mockGetInput.mockImplementation((name: string) => (name === "session_duration" ? "900" : ""));
    expect(resolveSessionDuration()).toBe(900);
  });

  it("accepts the AWS maximum (43200)", () => {
    mockGetInput.mockImplementation((name: string) => (name === "session_duration" ? "43200" : ""));
    expect(resolveSessionDuration()).toBe(43200);
  });

  it("throws on values below the AWS minimum", () => {
    mockGetInput.mockImplementation((name: string) => (name === "session_duration" ? "60" : ""));
    expect(() => resolveSessionDuration()).toThrow(/must be an integer between 900 and 43200/);
  });

  it("throws on values above the AWS maximum", () => {
    mockGetInput.mockImplementation((name: string) => (name === "session_duration" ? "100000" : ""));
    expect(() => resolveSessionDuration()).toThrow(/must be an integer between 900 and 43200/);
  });

  it("throws on non-numeric input", () => {
    mockGetInput.mockImplementation((name: string) => (name === "session_duration" ? "forever" : ""));
    expect(() => resolveSessionDuration()).toThrow(/must be an integer/);
  });
});

describe("assumeRoleWithOidc", () => {
  beforeEach(() => {
    mockGetIDToken.mockReset();
    mockGetIDToken.mockResolvedValue("mock-oidc-token");
    mockFetch.mockReset();
    mockSetSecret.mockReset();
  });

  it("returns temporary credentials from STS", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    const creds = await assumeRoleWithOidc("arn:aws:iam::123:role/test");
    expect(creds.accessKeyId).toBe("ASIA_OIDC");
    expect(creds.secretAccessKey).toBe("SECRET_OIDC");
    expect(creds.sessionToken).toBe("TOKEN_OIDC");
  });

  it("masks secret key and session token", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    await assumeRoleWithOidc("arn:aws:iam::123:role/test");
    expect(mockSetSecret).toHaveBeenCalledWith("SECRET_OIDC");
    expect(mockSetSecret).toHaveBeenCalledWith("TOKEN_OIDC");
  });

  it("requests OIDC token with correct audience", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    await assumeRoleWithOidc("arn:aws:iam::123:role/test");
    expect(mockGetIDToken).toHaveBeenCalledWith("sts.amazonaws.com");
  });

  it("includes DurationSeconds in the request body", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    await assumeRoleWithOidc("arn:aws:iam::123:role/test", { sessionDuration: 1800 });
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("DurationSeconds=1800");
  });

  it("uses default 3600 when no sessionDuration option provided", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    await assumeRoleWithOidc("arn:aws:iam::123:role/test");
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("DurationSeconds=3600");
  });

  it("uses custom sessionName when provided", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    await assumeRoleWithOidc("arn:aws:iam::123:role/test", { sessionName: "deploy-prod" });
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("RoleSessionName=deploy-prod");
  });

  it("throws on STS error response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "<Error><Message>Access Denied</Message></Error>",
    });

    await expect(assumeRoleWithOidc("arn:aws:iam::123:role/test")).rejects.toThrow(
      "STS AssumeRoleWithWebIdentity failed (403)",
    );
  });

  it("throws when STS response is missing fields", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<AssumeRoleWithWebIdentityResponse></AssumeRoleWithWebIdentityResponse>",
    });

    await expect(assumeRoleWithOidc("arn:aws:iam::123:role/test")).rejects.toThrow(
      "STS response missing credential fields",
    );
  });
});

describe("assumeRoleWithDeployerKey", () => {
  const deployerCreds = {
    accessKeyId: "AKIA_DEPLOYER",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  beforeEach(() => {
    mockFetch.mockReset();
    mockSetSecret.mockReset();
  });

  it("returns temporary credentials from STS AssumeRole", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    const creds = await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds);
    expect(creds.accessKeyId).toBe("ASIA_DEPLOYER");
    expect(creds.secretAccessKey).toBe("SECRET_DEPLOYER");
    expect(creds.sessionToken).toBe("TOKEN_DEPLOYER");
  });

  it("masks secret key and session token", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds);
    expect(mockSetSecret).toHaveBeenCalledWith("SECRET_DEPLOYER");
    expect(mockSetSecret).toHaveBeenCalledWith("TOKEN_DEPLOYER");
  });

  it("does NOT request a GitHub OIDC token (deployer key signs the request)", async () => {
    mockGetIDToken.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds);
    expect(mockGetIDToken).not.toHaveBeenCalled();
  });

  it("signs the request with a SigV4 Authorization header", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds);
    const callHeaders = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(callHeaders.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA_DEPLOYER\//);
    expect(callHeaders.Authorization).toMatch(/Signature=[a-f0-9]{64}$/);
  });

  it("includes x-amz-security-token header when deployer creds carry a session token", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", {
      ...deployerCreds,
      sessionToken: "TEMP_TOKEN",
    });
    const callHeaders = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(callHeaders["x-amz-security-token"]).toBe("TEMP_TOKEN");
  });

  it("posts AssumeRole action to STS with role_arn in body", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds);
    const callUrl = mockFetch.mock.calls[0]?.[0];
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callUrl).toBe("https://sts.amazonaws.com/");
    expect(callBody).toContain("Action=AssumeRole");
    expect(callBody).toContain("RoleArn=arn%3Aaws%3Aiam%3A%3A123%3Arole%2Fdeploy-app");
  });

  it("includes DurationSeconds in the request body", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds, { sessionDuration: 7200 });
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("DurationSeconds=7200");
  });

  it("uses custom sessionName when provided", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds, {
      sessionName: "deploy-staging",
    });
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("RoleSessionName=deploy-staging");
  });

  it("throws on STS error response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "<Error><Message>Access Denied</Message></Error>",
    });

    await expect(assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds)).rejects.toThrow(
      "STS AssumeRole failed (403)",
    );
  });

  it("throws when STS response is missing credential fields", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<AssumeRoleResponse></AssumeRoleResponse>",
    });

    await expect(assumeRoleWithDeployerKey("arn:aws:iam::123:role/deploy-app", deployerCreds)).rejects.toThrow(
      "STS response missing credential fields",
    );
  });
});

describe("getAwsConfig — auth path precedence", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockGetInput.mockReset();
    mockGetInput.mockReturnValue("");
    mockGetIDToken.mockReset();
    mockGetIDToken.mockResolvedValue("mock-oidc-token");
    mockFetch.mockReset();
    mockSetSecret.mockReset();
  });

  it("Path 1 (static-only): static creds + no role_arn → returns static creds directly", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_STATIC");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "STATIC_SECRET");

    const config = await getAwsConfig("alpha");

    expect(config.credentials.accessKeyId).toBe("AKIA_STATIC");
    expect(config.credentials.secretAccessKey).toBe("STATIC_SECRET");
    expect(config.credentials.sessionToken).toBeUndefined();
    expect(mockGetIDToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("Path 1: includes static session token from env when present", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_STATIC");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "STATIC_SECRET");
    vi.stubEnv("AWS_SESSION_TOKEN", "STATIC_TOKEN");

    const config = await getAwsConfig("production");

    expect(config.credentials.sessionToken).toBe("STATIC_TOKEN");
    expect(mockSetSecret).toHaveBeenCalledWith("STATIC_TOKEN");
  });

  it("Path 2 (deployer-key): static creds + role_arn → SigV4-signed AssumeRole, returns short-lived creds", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_DEPLOYER");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "DEPLOYER_SECRET");
    mockGetInput.mockImplementation((name: string) => (name === "role_arn" ? "arn:aws:iam::123:role/deploy-app" : ""));
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    const config = await getAwsConfig("beta");

    expect(config.credentials.accessKeyId).toBe("ASIA_DEPLOYER");
    expect(config.credentials.secretAccessKey).toBe("SECRET_DEPLOYER");
    expect(config.credentials.sessionToken).toBe("TOKEN_DEPLOYER");
    expect(mockGetIDToken).not.toHaveBeenCalled(); // OIDC NOT used
    const callHeaders = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(callHeaders.Authorization).toMatch(/^AWS4-HMAC-SHA256/);
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("Action=AssumeRole");
  });

  it("Path 2: works with aws_account_id + role_scope inputs (no explicit role_arn)", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_DEPLOYER");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "DEPLOYER_SECRET");
    mockGetInput.mockImplementation((name: string) => {
      if (name === "aws_account_id") return "999888777666";
      if (name === "role_scope") return "infra";
      return "";
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    const config = await getAwsConfig("production");

    expect(config.credentials.accessKeyId).toBe("ASIA_DEPLOYER");
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("RoleArn=arn%3Aaws%3Aiam%3A%3A999888777666%3Arole%2Fdeploy-infra");
  });

  it("Path 2: masks the deployer secret before any STS calls", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_DEPLOYER");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "DEPLOYER_SECRET");
    mockGetInput.mockImplementation((name: string) => (name === "role_arn" ? "arn:aws:iam::123:role/deploy-app" : ""));
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await getAwsConfig("alpha");

    expect(mockSetSecret).toHaveBeenCalledWith("DEPLOYER_SECRET");
  });

  it("Path 3 (OIDC): no static creds + role_arn → AssumeRoleWithWebIdentity via OIDC token", async () => {
    mockGetInput.mockImplementation((name: string) => (name === "role_arn" ? "arn:aws:iam::456:role/oidc-target" : ""));
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    const config = await getAwsConfig("alpha");

    expect(config.credentials.accessKeyId).toBe("ASIA_OIDC");
    expect(config.credentials.secretAccessKey).toBe("SECRET_OIDC");
    expect(mockGetIDToken).toHaveBeenCalledWith("sts.amazonaws.com");
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("Action=AssumeRoleWithWebIdentity");
  });

  it("returns config with default region when none provided", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_STATIC");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "STATIC_SECRET");

    const config = await getAwsConfig("alpha");
    expect(config.region).toBe("us-east-1");
    expect(config.environment).toBe("alpha");
  });

  it("uses explicit region when provided", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_STATIC");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "STATIC_SECRET");

    const config = await getAwsConfig("alpha", "eu-west-1");
    expect(config.region).toBe("eu-west-1");
  });

  it("throws when no auth method is available", async () => {
    await expect(getAwsConfig("alpha")).rejects.toThrow(/No AWS credentials available/);
  });

  it("propagates session_duration input through to the deployer-key path", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA_DEPLOYER");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "DEPLOYER_SECRET");
    mockGetInput.mockImplementation((name: string) => {
      if (name === "role_arn") return "arn:aws:iam::123:role/deploy-app";
      if (name === "session_duration") return "1800";
      return "";
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_ASSUMEROLE_RESPONSE });

    await getAwsConfig("alpha");
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("DurationSeconds=1800");
  });

  it("propagates session_duration through to the OIDC path", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "role_arn") return "arn:aws:iam::456:role/oidc-target";
      if (name === "session_duration") return "7200";
      return "";
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => MOCK_OIDC_RESPONSE });

    await getAwsConfig("alpha");
    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("DurationSeconds=7200");
  });
});

describe("exportAwsCredentials", () => {
  beforeEach(() => {
    mockExportVariable.mockReset();
  });

  it("exports all credential environment variables including session token", () => {
    exportAwsCredentials({
      region: "us-east-1",
      environment: "production",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET", sessionToken: "TOKEN" },
    });

    expect(mockExportVariable).toHaveBeenCalledWith("AWS_ACCESS_KEY_ID", "AKID");
    expect(mockExportVariable).toHaveBeenCalledWith("AWS_SECRET_ACCESS_KEY", "SECRET");
    expect(mockExportVariable).toHaveBeenCalledWith("AWS_SESSION_TOKEN", "TOKEN");
    expect(mockExportVariable).toHaveBeenCalledWith("AWS_REGION", "us-east-1");
    expect(mockExportVariable).toHaveBeenCalledWith("AWS_DEFAULT_REGION", "us-east-1");
  });

  it("skips session token when not provided", () => {
    exportAwsCredentials({
      region: "us-east-1",
      environment: "alpha",
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
    });

    expect(mockExportVariable).not.toHaveBeenCalledWith("AWS_SESSION_TOKEN", expect.anything());
  });
});
