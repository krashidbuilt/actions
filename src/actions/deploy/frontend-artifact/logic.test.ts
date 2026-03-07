import { describe, expect, it, type Mock, vi } from "vitest";

const { mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => ""),
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

const mockGetAwsConfig = vi.fn(async () => ({
  region: "us-east-1",
  environment: "alpha" as const,
  credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST" },
})) as Mock;
const mockExportAwsCredentials = vi.fn() as Mock;
const mockFindArtifactBucket = vi.fn(async () => "artifact.krashidbuilt.com");
const mockCheckArtifactVersionExists = vi.fn(async () => true) as Mock;
const mockFindApplicationBucket = vi.fn(async () => "ctrl.alpha.krashidbuilt.com") as Mock;
const mockFindDistributionId = vi.fn(async () => "E1234567890") as Mock;
const mockInvalidateCloudFront = vi.fn(async () => "INV123") as Mock;
const mockSyncFromArtifact = vi.fn(async () => {}) as Mock;
const mockAwsRegion = vi.fn(() => "us-east-1");
const mockGithubToken = vi.fn(() => "ghp_token");

vi.mock("../../../core/index.js", () => ({
  getAwsConfig: (...args: unknown[]) => mockGetAwsConfig(...args),
  exportAwsCredentials: (...args: unknown[]) => mockExportAwsCredentials(...args),
  findArtifactBucket: () => mockFindArtifactBucket(),
  checkArtifactVersionExists: (...args: unknown[]) => mockCheckArtifactVersionExists(...args),
  findApplicationBucket: (...args: unknown[]) => mockFindApplicationBucket(...args),
  findDistributionId: (...args: unknown[]) => mockFindDistributionId(...args),
  invalidateCloudFront: (...args: unknown[]) => mockInvalidateCloudFront(...args),
  syncFromArtifact: (...args: unknown[]) => mockSyncFromArtifact(...args),
  aws: { region: () => mockAwsRegion() },
  common: {
    githubToken: () => mockGithubToken(),
  },
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { getInputs, run } from "./logic.js";

describe("getInputs", () => {
  it("reads all required inputs", () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        version: "1.2.3",
        app_name: "ctrl",
        invalidate_cache: "true",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();

    expect(inputs.environment).toBe("alpha");
    expect(inputs.version).toBe("1.2.3");
    expect(inputs.appName).toBe("ctrl");
    expect(inputs.invalidateCache).toBe(true);
    expect(inputs.awsRegion).toBe("us-east-1");
    expect(inputs.githubToken).toBe("token");
  });

  it("sets invalidateCache to false when input is not 'true'", () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "production",
        version: "2.0.0",
        app_name: "ctrl",
        invalidate_cache: "false",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.invalidateCache).toBe(false);
  });

  it("sets invalidateCache to false when input is empty", () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "beta",
        version: "1.0.0",
        app_name: "ctrl",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.invalidateCache).toBe(false);
  });
});

describe("run", () => {
  it("performs full artifact deployment pipeline successfully", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        version: "1.2.3",
        app_name: "ctrl",
        invalidate_cache: "true",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    await run();

    // Verify AWS config
    expect(mockGetAwsConfig).toHaveBeenCalledWith("alpha", "us-east-1");
    expect(mockExportAwsCredentials).toHaveBeenCalled();

    // Verify outputs
    expect(mockSetOutput).toHaveBeenCalledWith("environment", "alpha");
    expect(mockSetOutput).toHaveBeenCalledWith("version", "1.2.3");
    expect(mockSetOutput).toHaveBeenCalledWith("app_name", "ctrl");

    // Verify artifact check
    expect(mockCheckArtifactVersionExists).toHaveBeenCalledWith("artifact.krashidbuilt.com", "ctrl", "1.2.3");

    // Verify sync
    expect(mockSyncFromArtifact).toHaveBeenCalledWith(
      "artifact.krashidbuilt.com",
      "ctrl",
      "1.2.3",
      "ctrl.alpha.krashidbuilt.com",
    );

    // Verify invalidation
    expect(mockFindDistributionId).toHaveBeenCalledWith("ctrl.alpha.krashidbuilt.com");
    expect(mockInvalidateCloudFront).toHaveBeenCalledWith("E1234567890");

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("throws when version does not exist in artifact bucket", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        version: "9.9.9",
        app_name: "ctrl",
        invalidate_cache: "false",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockCheckArtifactVersionExists.mockResolvedValue(false);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("Version 9.9.9 not found in artifact bucket for ctrl");
    expect(mockSyncFromArtifact).not.toHaveBeenCalled();
  });

  it("skips CloudFront invalidation when invalidate_cache is false", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "production",
        version: "2.0.0",
        app_name: "ctrl",
        invalidate_cache: "false",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockCheckArtifactVersionExists.mockResolvedValue(true);

    await run();

    expect(mockFindDistributionId).not.toHaveBeenCalled();
    expect(mockInvalidateCloudFront).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("calls setFailed with error message when an Error is thrown", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        version: "1.0.0",
        app_name: "ctrl",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockGetAwsConfig.mockRejectedValue(new Error("OIDC token fetch failed"));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("OIDC token fetch failed");
  });

  it("calls setFailed with generic message when a non-Error is thrown", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        version: "1.0.0",
        app_name: "ctrl",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockGetAwsConfig.mockRejectedValue("unexpected");

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
  });

  it("finds application bucket using the artifact bucket", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "beta",
        version: "3.0.0",
        app_name: "web",
        invalidate_cache: "false",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockCheckArtifactVersionExists.mockResolvedValue(true);
    mockFindArtifactBucket.mockResolvedValue("artifact.beta.krashidbuilt.com");
    mockFindApplicationBucket.mockResolvedValue("web.beta.krashidbuilt.com");

    await run();

    expect(mockFindApplicationBucket).toHaveBeenCalledWith("web", "beta");
    expect(mockSyncFromArtifact).toHaveBeenCalledWith(
      "artifact.beta.krashidbuilt.com",
      "web",
      "3.0.0",
      "web.beta.krashidbuilt.com",
    );
  });
});
