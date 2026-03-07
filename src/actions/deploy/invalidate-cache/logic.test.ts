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
const mockInvalidateCloudFront = vi.fn(async () => "INV_ABC123") as Mock;
const mockAwsRegion = vi.fn(() => "us-east-1");

vi.mock("../../../core/index.js", () => ({
  getAwsConfig: (...args: unknown[]) => mockGetAwsConfig(...args),
  exportAwsCredentials: (...args: unknown[]) => mockExportAwsCredentials(...args),
  findArtifactBucket: () => mockFindArtifactBucket(),
  findApplicationBucket: (...args: unknown[]) => mockFindApplicationBucket(...args),
  findDistributionId: (...args: unknown[]) => mockFindDistributionId(...args),
  invalidateCloudFront: (...args: unknown[]) => mockInvalidateCloudFront(...args),
  aws: { region: () => mockAwsRegion() },
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { getInputs, parsePaths, run } from "./logic.js";

describe("getInputs", () => {
  it("reads all required inputs", () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "production",
        app_name: "ctrl",
        paths: "/index.html,/assets/*",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("eu-west-1");

    const inputs = getInputs();

    expect(inputs.environment).toBe("production");
    expect(inputs.appName).toBe("ctrl");
    expect(inputs.paths).toBe("/index.html,/assets/*");
    expect(inputs.awsRegion).toBe("eu-west-1");
  });

  it("defaults paths to /* when not provided", () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        app_name: "web",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");

    const inputs = getInputs();
    expect(inputs.paths).toBe("/*");
  });
});

describe("parsePaths", () => {
  it("splits comma-separated paths and trims whitespace", () => {
    const result = parsePaths("/index.html, /assets/*, /css/*");
    expect(result).toEqual(["/index.html", "/assets/*", "/css/*"]);
  });

  it("handles single path", () => {
    const result = parsePaths("/*");
    expect(result).toEqual(["/*"]);
  });

  it("handles paths with extra spaces", () => {
    const result = parsePaths("  /a  ,  /b  ");
    expect(result).toEqual(["/a", "/b"]);
  });

  it("handles empty string", () => {
    const result = parsePaths("");
    expect(result).toEqual([""]);
  });
});

describe("run", () => {
  it("performs full cache invalidation pipeline successfully", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        app_name: "ctrl",
        paths: "/index.html,/assets/*",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");

    await run();

    // Verify AWS config
    expect(mockGetAwsConfig).toHaveBeenCalledWith("alpha", "us-east-1");
    expect(mockExportAwsCredentials).toHaveBeenCalled();

    // Verify bucket discovery
    expect(mockFindArtifactBucket).toHaveBeenCalled();
    expect(mockFindApplicationBucket).toHaveBeenCalledWith("ctrl", "alpha");

    // Verify distribution discovery
    expect(mockFindDistributionId).toHaveBeenCalledWith("ctrl.alpha.krashidbuilt.com");

    // Verify invalidation with parsed paths
    expect(mockInvalidateCloudFront).toHaveBeenCalledWith("E1234567890", ["/index.html", "/assets/*"]);

    // Verify outputs
    expect(mockSetOutput).toHaveBeenCalledWith("invalidation_id", "INV_ABC123");
    expect(mockSetOutput).toHaveBeenCalledWith("distribution_id", "E1234567890");

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("uses default path /* when no paths input is provided", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "production",
        app_name: "web",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");

    await run();

    expect(mockInvalidateCloudFront).toHaveBeenCalledWith("E1234567890", ["/*"]);
  });

  it("calls setFailed with error message when an Error is thrown", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        app_name: "ctrl",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGetAwsConfig.mockRejectedValue(new Error("OIDC failed"));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("OIDC failed");
  });

  it("calls setFailed with generic message when a non-Error is thrown", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        app_name: "ctrl",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockGetAwsConfig.mockRejectedValue(42);

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
  });

  it("handles findDistributionId failure", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "beta",
        app_name: "ctrl",
        paths: "/*",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockFindDistributionId.mockRejectedValue(new Error("Could not find CloudFront distribution"));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("Could not find CloudFront distribution");
  });

  it("handles findArtifactBucket failure", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        environment: "alpha",
        app_name: "ctrl",
      };
      return inputs[name] || "";
    });
    mockAwsRegion.mockReturnValue("us-east-1");
    mockFindArtifactBucket.mockRejectedValue(new Error("Could not find artifact bucket"));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("Could not find artifact bucket");
  });
});
