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
const mockFindApplicationBucket = vi.fn(async () => "ctrl.alpha.krashidbuilt.com") as Mock;
const mockFindDistributionId = vi.fn(async () => "E1234567890") as Mock;
const mockInvalidateCloudFront = vi.fn(async () => "INV123") as Mock;
const mockListArtifactVersions = vi.fn(async () => ["2.0.0", "1.0.0"]) as Mock;
const mockSyncFromArtifact = vi.fn(async () => {}) as Mock;
const mockIsValidEnvironment = vi.fn((v: string) => ["alpha", "beta", "production"].includes(v));
const mockEnvironmentInput = vi.fn(() => "alpha" as string | undefined);

vi.mock("../../../core/index.js", () => ({
  getAwsConfig: (...args: unknown[]) => mockGetAwsConfig(...args),
  exportAwsCredentials: (...args: unknown[]) => mockExportAwsCredentials(...args),
  findArtifactBucket: () => mockFindArtifactBucket(),
  findApplicationBucket: (...args: unknown[]) => mockFindApplicationBucket(...args),
  findDistributionId: (...args: unknown[]) => mockFindDistributionId(...args),
  invalidateCloudFront: (...args: unknown[]) => mockInvalidateCloudFront(...args),
  listArtifactVersions: (...args: unknown[]) => mockListArtifactVersions(...args),
  syncFromArtifact: (...args: unknown[]) => mockSyncFromArtifact(...args),
  isValidEnvironment: (v: string) => mockIsValidEnvironment(v),
  VALID_ENVIRONMENTS: ["alpha", "beta", "production"],
  common: {
    environment: () => mockEnvironmentInput(),
  },
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { run, shouldInvalidateCache } from "./logic.js";

describe("shouldInvalidateCache", () => {
  it("returns true for alpha regardless of input", () => {
    expect(shouldInvalidateCache("alpha", false)).toBe(true);
    expect(shouldInvalidateCache("alpha", true)).toBe(true);
  });

  it("returns true for beta regardless of input", () => {
    expect(shouldInvalidateCache("beta", false)).toBe(true);
    expect(shouldInvalidateCache("beta", true)).toBe(true);
  });

  it("returns true for production when input is true", () => {
    expect(shouldInvalidateCache("production", true)).toBe(true);
  });

  it("returns false for production when input is false", () => {
    expect(shouldInvalidateCache("production", false)).toBe(false);
  });
});

describe("run", () => {
  it("performs full rollback pipeline successfully", async () => {
    mockEnvironmentInput.mockReturnValue("alpha");
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        app_name: "ctrl",
        invalidate_cache: "true",
      };
      return inputs[name] || "";
    });
    mockListArtifactVersions.mockResolvedValue(["2.0.0", "1.0.0"]);

    await run();

    // Verify AWS config
    expect(mockGetAwsConfig).toHaveBeenCalledWith("alpha");
    expect(mockExportAwsCredentials).toHaveBeenCalled();

    // Verify bucket discovery
    expect(mockFindArtifactBucket).toHaveBeenCalled();
    expect(mockFindApplicationBucket).toHaveBeenCalledWith("ctrl", "alpha");

    // Verify version listing
    expect(mockListArtifactVersions).toHaveBeenCalledWith("artifact.krashidbuilt.com", "ctrl");

    // Verify sync to previous version (index 1, not 0)
    expect(mockSyncFromArtifact).toHaveBeenCalledWith(
      "artifact.krashidbuilt.com",
      "ctrl",
      "1.0.0",
      "ctrl.alpha.krashidbuilt.com",
    );

    // Verify invalidation (alpha always invalidates)
    expect(mockFindDistributionId).toHaveBeenCalledWith("ctrl.alpha.krashidbuilt.com");
    expect(mockInvalidateCloudFront).toHaveBeenCalledWith("E1234567890");

    // Verify outputs
    expect(mockSetOutput).toHaveBeenCalledWith("current_version", "2.0.0");
    expect(mockSetOutput).toHaveBeenCalledWith("rolled_back_to", "1.0.0");

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("throws error when environment input is missing", async () => {
    mockEnvironmentInput.mockReturnValue(undefined);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("environment input is required");
  });

  it("throws error when environment is invalid", async () => {
    mockEnvironmentInput.mockReturnValue("invalid-env");
    mockIsValidEnvironment.mockReturnValue(false);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      'Invalid environment "invalid-env". Valid values: alpha, beta, production',
    );
  });

  it("throws error when fewer than 2 versions exist", async () => {
    mockEnvironmentInput.mockReturnValue("alpha");
    mockGetInput.mockImplementation((name: string) => {
      if (name === "app_name") return "ctrl";
      return "";
    });
    mockListArtifactVersions.mockResolvedValue(["1.0.0"]);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("Need at least 2 versions to rollback");
  });

  it("throws error when no versions exist", async () => {
    mockEnvironmentInput.mockReturnValue("alpha");
    mockGetInput.mockImplementation((name: string) => {
      if (name === "app_name") return "ctrl";
      return "";
    });
    mockListArtifactVersions.mockResolvedValue([]);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("Need at least 2 versions to rollback");
  });

  it("skips CloudFront invalidation for production when invalidate_cache is 'false'", async () => {
    mockEnvironmentInput.mockReturnValue("production");
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        app_name: "ctrl",
        invalidate_cache: "false",
      };
      return inputs[name] || "";
    });
    mockListArtifactVersions.mockResolvedValue(["3.0.0", "2.0.0", "1.0.0"]);

    await run();

    // shouldInvalidateCache("production", false) = false
    expect(mockFindDistributionId).not.toHaveBeenCalled();
    expect(mockInvalidateCloudFront).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("always invalidates for alpha even when invalidate_cache is not set", async () => {
    mockEnvironmentInput.mockReturnValue("alpha");
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        app_name: "ctrl",
      };
      return inputs[name] || "";
    });
    // When invalidate_cache input is empty string, `!== "false"` is true
    mockListArtifactVersions.mockResolvedValue(["2.0.0", "1.0.0"]);

    await run();

    expect(mockInvalidateCloudFront).toHaveBeenCalled();
  });

  it("always invalidates for beta even when invalidate_cache is 'false'", async () => {
    mockEnvironmentInput.mockReturnValue("beta");
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        app_name: "ctrl",
        invalidate_cache: "false",
      };
      return inputs[name] || "";
    });
    // shouldInvalidateCache("beta", false) = true (not production)
    mockListArtifactVersions.mockResolvedValue(["2.0.0", "1.0.0"]);

    await run();

    expect(mockInvalidateCloudFront).toHaveBeenCalled();
  });

  it("invalidates for production when invalidate_cache is not 'false'", async () => {
    mockEnvironmentInput.mockReturnValue("production");
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        app_name: "ctrl",
        invalidate_cache: "true",
      };
      return inputs[name] || "";
    });
    mockListArtifactVersions.mockResolvedValue(["2.0.0", "1.0.0"]);

    await run();

    expect(mockInvalidateCloudFront).toHaveBeenCalled();
  });

  it("calls setFailed with error message when an Error is thrown", async () => {
    mockEnvironmentInput.mockReturnValue("alpha");
    mockGetInput.mockImplementation((name: string) => {
      if (name === "app_name") return "ctrl";
      return "";
    });
    mockGetAwsConfig.mockRejectedValue(new Error("AWS error"));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("AWS error");
  });

  it("calls setFailed with generic message when a non-Error is thrown", async () => {
    mockEnvironmentInput.mockReturnValue("alpha");
    mockGetInput.mockImplementation((name: string) => {
      if (name === "app_name") return "ctrl";
      return "";
    });
    mockGetAwsConfig.mockRejectedValue(123);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
  });

  it("rolls back to the second newest version among many", async () => {
    mockEnvironmentInput.mockReturnValue("alpha");
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        app_name: "ctrl",
        invalidate_cache: "true",
      };
      return inputs[name] || "";
    });
    mockListArtifactVersions.mockResolvedValue(["5.0.0", "4.0.0", "3.0.0", "2.0.0", "1.0.0"]);

    await run();

    // Should sync to version at index 1 (4.0.0), not 0 (5.0.0)
    expect(mockSyncFromArtifact).toHaveBeenCalledWith(
      "artifact.krashidbuilt.com",
      "ctrl",
      "4.0.0",
      "ctrl.alpha.krashidbuilt.com",
    );
    expect(mockSetOutput).toHaveBeenCalledWith("current_version", "5.0.0");
    expect(mockSetOutput).toHaveBeenCalledWith("rolled_back_to", "4.0.0");
  });
});
