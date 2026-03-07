import { describe, expect, it, type Mock, vi } from "vitest";

const { mockExec, mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
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

const mockDetectEnvironment = vi.fn(() => "alpha" as const) as Mock;
const mockGetRefForEnvironment = vi.fn(() => "refs/heads/develop");
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
const mockReadPackageVersion = vi.fn(() => "1.0.0") as Mock;
const mockTryReadPackageJson = vi.fn(() => ({ name: "@krashidbuilt/ctrl" })) as Mock;
const mockStripScope = vi.fn((name: string) => name.replace(/^@[^/]+\//, ""));
const mockWorkingDirectory = vi.fn(() => ".");
const mockBuildDirectory = vi.fn(() => "dist");
const mockEnvironmentInput = vi.fn(() => undefined as string | undefined);
const mockGithubToken = vi.fn(() => "ghp_token");
const mockAwsRegion = vi.fn(() => "us-east-1");
const mockGetDomain = vi.fn(() => "alpha.krashidbuilt.com") as Mock;

vi.mock("../../../core/index.js", () => ({
  detectEnvironment: (...args: unknown[]) => mockDetectEnvironment(...args),
  github: {
    getRefForEnvironment: () => mockGetRefForEnvironment(),
  },
  getAwsConfig: (...args: unknown[]) => mockGetAwsConfig(...args),
  exportAwsCredentials: (...args: unknown[]) => mockExportAwsCredentials(...args),
  findArtifactBucket: () => mockFindArtifactBucket(),
  findApplicationBucket: (...args: unknown[]) => mockFindApplicationBucket(...args),
  findDistributionId: (...args: unknown[]) => mockFindDistributionId(...args),
  invalidateCloudFront: (...args: unknown[]) => mockInvalidateCloudFront(...args),
  readPackageVersion: (...args: unknown[]) => mockReadPackageVersion(...args),
  tryReadPackageJson: (...args: unknown[]) => mockTryReadPackageJson(...args),
  stripScope: (name: string) => mockStripScope(name),
  getDomain: (...args: unknown[]) => mockGetDomain(...args),
  aws: { region: () => mockAwsRegion() },
  build: { directory: () => mockBuildDirectory() },
  common: {
    workingDirectory: () => mockWorkingDirectory(),
    githubToken: () => mockGithubToken(),
    environment: () => mockEnvironmentInput(),
  },
  BUILD: { DEFAULT_FRONTEND_APP: "frontend-app" },
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

const mockGetLastNVersions = vi.fn(async () => ["1.0.0", "0.9.0"]) as Mock;
const mockGetFilesFromVersions = vi.fn(async () => new Set(["index.html", "assets/main.js"])) as Mock;
const mockGetAllFilesFromBucket = vi.fn(async () => ["index.html", "assets/main.js", "assets/old.js"]) as Mock;
const mockDetermineFilesToDelete = vi.fn(() => ["assets/old.js"]) as Mock;
const mockDeleteFilesInBatches = vi.fn(async () => {}) as Mock;

vi.mock("./cleanup.js", () => ({
  getLastNVersions: (...args: unknown[]) => mockGetLastNVersions(...args),
  getFilesFromVersions: (...args: unknown[]) => mockGetFilesFromVersions(...args),
  getAllFilesFromBucket: (...args: unknown[]) => mockGetAllFilesFromBucket(...args),
  determineFilesToDelete: (...args: unknown[]) => mockDetermineFilesToDelete(...args),
  deleteFilesInBatches: (...args: unknown[]) => mockDeleteFilesInBatches(...args),
}));

import { detectAppName, getInputs, run } from "./logic.js";

describe("getInputs", () => {
  it("parses invalidation paths from comma-separated input", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidation_paths") return "/index.html, /assets/*";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.invalidationPaths).toEqual(["/index.html", "/assets/*"]);
  });

  it("defaults invalidation paths to /* when empty", () => {
    mockGetInput.mockReturnValue("");
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.invalidationPaths).toEqual(["/*"]);
  });

  it("parses versions_to_keep as integer with default of 3", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "versions_to_keep") return "5";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.versionsToKeep).toBe(5);
  });

  it("defaults versions_to_keep to 3 when input is empty", () => {
    mockGetInput.mockReturnValue("");
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.versionsToKeep).toBe(3);
  });

  it("defaults versions_to_keep to 3 when input is NaN", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "versions_to_keep") return "not-a-number";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.versionsToKeep).toBe(3);
  });

  it("sets invalidateCache to true when input is 'true'", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "true";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.invalidateCache).toBe(true);
  });

  it("sets invalidateCache to false when input is not 'true'", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "false";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.invalidateCache).toBe(false);
  });

  it("sets appName to undefined when not provided", () => {
    mockGetInput.mockReturnValue("");
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.appName).toBeUndefined();
  });

  it("sets appName when provided", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "app_name") return "my-app";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.appName).toBe("my-app");
  });

  it("filters empty strings from invalidation paths", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidation_paths") return "/a, , /b";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");

    const inputs = getInputs();
    expect(inputs.invalidationPaths).toEqual(["/a", "/b"]);
  });
});

describe("detectAppName", () => {
  it("strips scope from package.json name", () => {
    mockTryReadPackageJson.mockReturnValue({ name: "@krashidbuilt/ctrl" });
    const name = detectAppName("/workspace");
    expect(name).toBe("ctrl");
  });

  it("returns package name when no scope", () => {
    mockTryReadPackageJson.mockReturnValue({ name: "my-app" });
    const name = detectAppName("/workspace");
    expect(name).toBe("my-app");
  });

  it("falls back to DEFAULT_FRONTEND_APP when no package.json", () => {
    mockTryReadPackageJson.mockReturnValue(null);
    const name = detectAppName("/workspace");
    expect(name).toBe("frontend-app");
  });

  it("falls back to DEFAULT_FRONTEND_APP when name is missing", () => {
    mockTryReadPackageJson.mockReturnValue({});
    const name = detectAppName("/workspace");
    expect(name).toBe("frontend-app");
  });
});

describe("run", () => {
  it("performs full deployment pipeline successfully", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "true";
      if (name === "invalidation_paths") return "/*";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockReturnValue("alpha");
    mockReadPackageVersion.mockReturnValue("1.2.3");
    mockTryReadPackageJson.mockReturnValue({ name: "@krashidbuilt/ctrl" });
    mockGetDomain.mockReturnValue("alpha.krashidbuilt.com");

    await run();

    // Verify AWS config
    expect(mockGetAwsConfig).toHaveBeenCalled();
    expect(mockExportAwsCredentials).toHaveBeenCalled();

    // Verify outputs
    expect(mockSetOutput).toHaveBeenCalledWith("environment", "alpha");
    expect(mockSetOutput).toHaveBeenCalledWith("version", "1.2.3");
    expect(mockSetOutput).toHaveBeenCalledWith("url", "https://ctrl.alpha.krashidbuilt.com");

    // Verify S3 uploads
    expect(mockExec).toHaveBeenCalledWith("aws", expect.arrayContaining(["s3", "cp", "--recursive"]));
    expect(mockExec).toHaveBeenCalledWith("aws", expect.arrayContaining(["s3", "sync"]));

    // Verify CloudFront invalidation
    expect(mockInvalidateCloudFront).toHaveBeenCalledWith("E1234567890", ["/*"]);

    // Verify cleanup
    expect(mockGetLastNVersions).toHaveBeenCalled();
    expect(mockDeleteFilesInBatches).toHaveBeenCalled();

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("skips CloudFront invalidation when invalidate_cache is false", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "false";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockReturnValue("alpha");
    mockReadPackageVersion.mockReturnValue("1.0.0");
    mockTryReadPackageJson.mockReturnValue({ name: "@krashidbuilt/ctrl" });
    mockGetDomain.mockReturnValue("alpha.krashidbuilt.com");

    await run();

    expect(mockInvalidateCloudFront).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("uses explicit app_name when provided", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "app_name") return "custom-app";
      if (name === "invalidate_cache") return "false";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockReturnValue("alpha");
    mockReadPackageVersion.mockReturnValue("1.0.0");
    mockGetDomain.mockReturnValue("alpha.krashidbuilt.com");

    await run();

    expect(mockFindApplicationBucket).toHaveBeenCalledWith("custom-app", "alpha", undefined);
    expect(mockSetOutput).toHaveBeenCalledWith("url", "https://custom-app.alpha.krashidbuilt.com");
  });

  it("handles cleanup failure gracefully without failing deployment", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "false";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockReturnValue("alpha");
    mockReadPackageVersion.mockReturnValue("1.0.0");
    mockTryReadPackageJson.mockReturnValue({ name: "ctrl" });
    mockGetDomain.mockReturnValue("alpha.krashidbuilt.com");
    mockGetLastNVersions.mockRejectedValue(new Error("S3 access denied"));

    await run();

    // Deployment should still succeed
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("handles cleanup failure with non-Error gracefully", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "false";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockReturnValue("alpha");
    mockReadPackageVersion.mockReturnValue("1.0.0");
    mockTryReadPackageJson.mockReturnValue({ name: "ctrl" });
    mockGetDomain.mockReturnValue("alpha.krashidbuilt.com");
    mockGetLastNVersions.mockRejectedValue("string error");

    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("skips delete when no files to clean up", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "false";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockReturnValue("alpha");
    mockReadPackageVersion.mockReturnValue("1.0.0");
    mockTryReadPackageJson.mockReturnValue({ name: "ctrl" });
    mockGetDomain.mockReturnValue("alpha.krashidbuilt.com");
    mockDetermineFilesToDelete.mockReturnValue([]);

    await run();

    expect(mockDeleteFilesInBatches).not.toHaveBeenCalled();
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("calls setFailed with error message when deployment throws Error", async () => {
    mockGetInput.mockReturnValue("");
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockImplementation(() => {
      throw new Error("Cannot detect environment");
    });

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("Cannot detect environment");
  });

  it("calls setFailed with generic message when deployment throws non-Error", async () => {
    mockGetInput.mockReturnValue("");
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("dist");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockImplementation(() => {
      throw "unexpected string error";
    });

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
  });

  it("uploads to artifact bucket with correct version path", async () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "invalidate_cache") return "false";
      return "";
    });
    mockEnvironmentInput.mockReturnValue(undefined);
    mockBuildDirectory.mockReturnValue("build");
    mockWorkingDirectory.mockReturnValue(".");
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGithubToken.mockReturnValue("token");
    mockDetectEnvironment.mockReturnValue("production");
    mockReadPackageVersion.mockReturnValue("2.5.0");
    mockTryReadPackageJson.mockReturnValue({ name: "ctrl" });
    mockGetDomain.mockReturnValue("krashidbuilt.com");

    await run();

    // Verify the artifact upload uses the version
    const cpCall = mockExec.mock.calls.find((call) => Array.isArray(call[1]) && (call[1] as string[]).includes("cp"));
    expect(cpCall).toBeDefined();
    const cpArgs = cpCall![1] as string[];
    expect(cpArgs).toContain("s3://artifact.krashidbuilt.com/ctrl/2.5.0");
  });
});
