import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  isDebug: vi.fn(() => false),
}));

const { mockAwsRegion, mockIsValidEnvironment, mockGetAwsConfig, mockExportAwsCredentials } = vi.hoisted(() => ({
  mockAwsRegion: vi.fn(() => "us-east-1"),
  mockIsValidEnvironment: vi.fn((_value: string) => true),
  mockGetAwsConfig: vi.fn(async () => ({
    region: "us-east-1",
    environment: "alpha",
    credentials: {
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOKEN",
    },
  })) as Mock,
  mockExportAwsCredentials: vi.fn(),
}));

vi.mock("../../../core/index.js", () => ({
  aws: { region: mockAwsRegion },
  isValidEnvironment: mockIsValidEnvironment,
  getAwsConfig: mockGetAwsConfig,
  exportAwsCredentials: mockExportAwsCredentials,
  VALID_ENVIRONMENTS: ["alpha", "beta", "production"],
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { run } from "./logic.js";

describe("configure-aws run", () => {
  beforeEach(() => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "environment") return "alpha";
      return "";
    });
    mockIsValidEnvironment.mockReturnValue(true);
    mockGetAwsConfig.mockResolvedValue({
      region: "us-east-1",
      environment: "alpha",
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
        accountId: "123456789012",
      },
    });
  });

  it("configures AWS credentials for a valid environment", async () => {
    await run();

    expect(mockGetInput).toHaveBeenCalledWith("environment", { required: true });
    expect(mockAwsRegion).toHaveBeenCalled();
    expect(mockIsValidEnvironment).toHaveBeenCalledWith("alpha");
    expect(mockGetAwsConfig).toHaveBeenCalledWith("alpha", "us-east-1");
    expect(mockExportAwsCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "us-east-1",
        environment: "alpha",
      }),
    );
    expect(mockSetOutput).toHaveBeenCalledWith("region", "us-east-1");
    expect(mockSetOutput).toHaveBeenCalledWith("account_id", "123456789012");
  });

  it("does not set account_id output when accountId is missing", async () => {
    mockGetAwsConfig.mockResolvedValue({
      region: "us-east-1",
      environment: "alpha",
      credentials: {
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
        sessionToken: "TOKEN",
      },
    });

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith("region", "us-east-1");
    expect(mockSetOutput).not.toHaveBeenCalledWith("account_id", expect.anything());
  });

  it("fails with an error for an invalid environment", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "environment") return "invalid-env";
      return "";
    });
    mockIsValidEnvironment.mockReturnValue(false);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(expect.stringContaining("Invalid environment: invalid-env"));
  });

  it("fails with error message when Error is thrown", async () => {
    mockGetAwsConfig.mockRejectedValue(new Error("OIDC token expired"));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("OIDC token expired");
  });

  it("fails with generic message when non-Error is thrown", async () => {
    mockGetAwsConfig.mockRejectedValue("some string error");

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
  });

  it("uses the correct region from aws.region()", async () => {
    mockAwsRegion.mockReturnValue("eu-west-1");

    await run();

    expect(mockGetAwsConfig).toHaveBeenCalledWith("alpha", "eu-west-1");
  });
});
