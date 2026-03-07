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

import { assumeRoleWithOidc, exportAwsCredentials, getAwsConfig, resolveRoleArn } from "./aws-credentials.js";

const MOCK_STS_RESPONSE = `
<AssumeRoleWithWebIdentityResponse>
  <AssumeRoleWithWebIdentityResult>
    <Credentials>
      <AccessKeyId>ASIA_TEST</AccessKeyId>
      <SecretAccessKey>SECRET_TEST</SecretAccessKey>
      <SessionToken>TOKEN_TEST</SessionToken>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

describe("resolveRoleArn", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockGetInput.mockReset();
  });

  it("resolves from action input", () => {
    mockGetInput.mockImplementation((name: string) => (name === "role_arn" ? "arn:aws:iam::123:role/test" : ""));
    expect(resolveRoleArn()).toBe("arn:aws:iam::123:role/test");
  });

  it("falls back to environment variable", () => {
    mockGetInput.mockReturnValue("");
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::456:role/env");
    expect(resolveRoleArn()).toBe("arn:aws:iam::456:role/env");
  });

  it("throws when neither input nor env var is set", () => {
    mockGetInput.mockReturnValue("");
    expect(() => resolveRoleArn()).toThrow("AWS role ARN not found");
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
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => MOCK_STS_RESPONSE,
    });

    const creds = await assumeRoleWithOidc("arn:aws:iam::123:role/test");
    expect(creds.accessKeyId).toBe("ASIA_TEST");
    expect(creds.secretAccessKey).toBe("SECRET_TEST");
    expect(creds.sessionToken).toBe("TOKEN_TEST");
  });

  it("masks secret key and session token", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => MOCK_STS_RESPONSE,
    });

    await assumeRoleWithOidc("arn:aws:iam::123:role/test");
    expect(mockSetSecret).toHaveBeenCalledWith("SECRET_TEST");
    expect(mockSetSecret).toHaveBeenCalledWith("TOKEN_TEST");
  });

  it("requests OIDC token with correct audience", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => MOCK_STS_RESPONSE,
    });

    await assumeRoleWithOidc("arn:aws:iam::123:role/test");
    expect(mockGetIDToken).toHaveBeenCalledWith("sts.amazonaws.com");
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

describe("getAwsConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockGetInput.mockReset();
    mockGetIDToken.mockReset();
    mockGetIDToken.mockResolvedValue("mock-oidc-token");
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => MOCK_STS_RESPONSE,
    });
  });

  it("returns config with default region", async () => {
    mockGetInput.mockImplementation((name: string) => (name === "role_arn" ? "arn:aws:iam::123:role/test" : ""));

    const config = await getAwsConfig("alpha");
    expect(config.region).toBe("us-east-1");
    expect(config.environment).toBe("alpha");
    expect(config.credentials.accessKeyId).toBe("ASIA_TEST");
  });

  it("uses explicit region when provided", async () => {
    mockGetInput.mockImplementation((name: string) => (name === "role_arn" ? "arn:aws:iam::123:role/test" : ""));

    const config = await getAwsConfig("alpha", "eu-west-1");
    expect(config.region).toBe("eu-west-1");
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
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      },
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
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
      },
    });

    expect(mockExportVariable).not.toHaveBeenCalledWith("AWS_SESSION_TOKEN", expect.anything());
  });
});
