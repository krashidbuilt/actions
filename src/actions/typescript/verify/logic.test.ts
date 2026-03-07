import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockExec, mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
}));

const { mockWorkingDirectory, mockDetectPackageManager, mockGetRunCommand } = vi.hoisted(() => ({
  mockWorkingDirectory: vi.fn(() => "."),
  mockDetectPackageManager: vi.fn(() => ({
    packageManager: "bun" as const,
    hasLockfile: true,
    lockfilePath: "/tmp/bun.lock",
    lockfileName: "bun.lock",
  })) as Mock,
  mockGetRunCommand: vi.fn((pm: string, script: string) => `${pm} run ${script}`) as Mock,
}));

const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  startGroup: vi.fn(),
  endGroup: vi.fn(),
  group: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  isDebug: vi.fn(() => false),
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
}));

vi.mock("../../../core/index.js", () => ({
  common: { workingDirectory: mockWorkingDirectory },
  detectPackageManager: mockDetectPackageManager,
  getRunCommand: mockGetRunCommand,
  Logger: class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
    startGroup = vi.fn();
    endGroup = vi.fn();
    group = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
  },
}));

import { run } from "./logic.js";

/**
 * Helper to set up mockReadFileSync to return a package.json with specified scripts.
 */
function setupPackageJson(scripts: Record<string, string> = {}): void {
  mockReadFileSync.mockReturnValue(JSON.stringify({ scripts }));
}

describe("typescript/verify", () => {
  beforeEach(() => {
    mockGetInput.mockImplementation((_name: string) => "");
  });

  describe("getInputs", () => {
    it("defaults all options correctly", async () => {
      setupPackageJson({ build: "tsc", verify: "biome check ." });

      await run();

      // run_build defaults to true (not "false"), run_verify defaults to true, run_tests defaults to false
      // build and verify should both run
      expect(mockExec).toHaveBeenCalledTimes(2);
    });

    it("uses custom node_options when provided", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "node_options") return "--max-old-space-size=4096";
        return "";
      });

      setupPackageJson({ build: "tsc", verify: "biome check ." });

      await run();

      expect(mockExec).toHaveBeenCalledWith(
        "bun",
        ["run", "build"],
        expect.objectContaining({
          env: expect.objectContaining({
            NODE_OPTIONS: "--max-old-space-size=4096",
          }),
        }),
      );
    });

    it("uses default node_options when not provided", async () => {
      setupPackageJson({ build: "tsc" });

      await run();

      expect(mockExec).toHaveBeenCalledWith(
        "bun",
        ["run", "build"],
        expect.objectContaining({
          env: expect.objectContaining({
            NODE_OPTIONS: "--max-old-space-size=8192",
          }),
        }),
      );
    });

    it("passes package_manager hint to detectPackageManager", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "npm";
        return "";
      });

      setupPackageJson({});

      await run();

      expect(mockDetectPackageManager).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ hint: "npm" }),
      );
    });
  });

  describe("build step", () => {
    it("runs build when run_build is true and build script exists", async () => {
      setupPackageJson({ build: "tsc -b" });

      await run();

      expect(mockExec).toHaveBeenCalledWith("bun", ["run", "build"], expect.any(Object));
      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "true");
    });

    it("skips build when run_build is false", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_build") return "false";
        return "";
      });

      setupPackageJson({ build: "tsc -b", verify: "biome check ." });

      await run();

      // Should not call build, but should set build_success to true
      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "true");
      // verify should still run
      expect(mockExec).toHaveBeenCalledWith("bun", ["run", "verify"], expect.any(Object));
    });

    it("skips build when no build script in package.json", async () => {
      setupPackageJson({ verify: "biome check ." });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "true");
    });

    it("fails early when build fails", async () => {
      setupPackageJson({ build: "tsc -b", verify: "biome check ." });

      mockExec.mockRejectedValueOnce(Object.assign(new Error("build failed"), { exitCode: 2 }));

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "false");
      expect(mockSetFailed).toHaveBeenCalledWith("Build failed (exit code 2)");
    });

    it("uses exit code 1 when build error has no exitCode", async () => {
      setupPackageJson({ build: "tsc -b", verify: "biome check ." });

      mockExec.mockRejectedValueOnce(new Error("build failed"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("Build failed (exit code 1)");
    });
  });

  describe("verify step", () => {
    it("runs verify when run_verify is true and verify script exists", async () => {
      setupPackageJson({ verify: "biome check ." });

      await run();

      expect(mockExec).toHaveBeenCalledWith("bun", ["run", "verify"], expect.any(Object));
      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "true");
    });

    it("skips verify when run_verify is false", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_verify") return "false";
        return "";
      });

      setupPackageJson({ verify: "biome check ." });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "true");
      // verify script should NOT have been called
      const verifyCalls = mockExec.mock.calls.filter((call) => call[0] === "bun" && call[1]?.[1] === "verify");
      expect(verifyCalls).toHaveLength(0);
    });

    it("skips verify when no verify script in package.json", async () => {
      setupPackageJson({ build: "tsc -b" });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "true");
    });

    it("fails early when verify fails", async () => {
      setupPackageJson({ verify: "biome check ." });

      mockExec.mockRejectedValueOnce(Object.assign(new Error("verify failed"), { exitCode: 3 }));

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "false");
      expect(mockSetFailed).toHaveBeenCalledWith("Verification failed (exit code 3)");
    });

    it("runs verify after successful build", async () => {
      setupPackageJson({ build: "tsc -b", verify: "biome check ." });

      await run();

      expect(mockExec).toHaveBeenCalledTimes(2);
      // Build runs first
      expect(mockExec).toHaveBeenNthCalledWith(1, "bun", ["run", "build"], expect.any(Object));
      // Then verify
      expect(mockExec).toHaveBeenNthCalledWith(2, "bun", ["run", "verify"], expect.any(Object));
    });
  });

  describe("test step", () => {
    it("runs tests when run_tests is true and test script exists", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_tests") return "true";
        return "";
      });

      setupPackageJson({ test: "vitest run" });

      await run();

      expect(mockExec).toHaveBeenCalledWith("bun", ["run", "test"], expect.any(Object));
      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "true");
    });

    it("skips tests when run_tests is not true", async () => {
      setupPackageJson({ test: "vitest run" });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "true");
      const testCalls = mockExec.mock.calls.filter((call) => call[0] === "bun" && call[1]?.[1] === "test");
      expect(testCalls).toHaveLength(0);
    });

    it("skips tests when no test script in package.json", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_tests") return "true";
        return "";
      });

      setupPackageJson({ build: "tsc -b" });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "true");
    });

    it("fails when tests fail", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_tests") return "true";
        return "";
      });

      setupPackageJson({ test: "vitest run" });

      mockExec.mockRejectedValueOnce(Object.assign(new Error("tests failed"), { exitCode: 1 }));

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "false");
      expect(mockSetFailed).toHaveBeenCalledWith("Tests failed (exit code 1)");
    });

    it("uses exit code 1 when test error has no exitCode property", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_tests") return "true";
        return "";
      });

      setupPackageJson({ test: "vitest run" });

      mockExec.mockRejectedValueOnce(new Error("tests failed"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("Tests failed (exit code 1)");
    });
  });

  describe("hasScript fallback", () => {
    it("returns false when package.json cannot be read", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      await run();

      // All scripts should be skipped - outputs set to true
      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "true");
    });

    it("returns false when package.json has no scripts key", async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ name: "test-pkg" }));

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "true");
    });
  });

  describe("full pipeline", () => {
    it("runs build, verify, and test in sequence when all enabled", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_tests") return "true";
        return "";
      });

      setupPackageJson({ build: "tsc -b", verify: "biome check .", test: "vitest run" });

      await run();

      expect(mockExec).toHaveBeenCalledTimes(3);
      expect(mockExec).toHaveBeenNthCalledWith(1, "bun", ["run", "build"], expect.any(Object));
      expect(mockExec).toHaveBeenNthCalledWith(2, "bun", ["run", "verify"], expect.any(Object));
      expect(mockExec).toHaveBeenNthCalledWith(3, "bun", ["run", "test"], expect.any(Object));

      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "true");
    });

    it("stops at build failure without running verify or test", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_tests") return "true";
        return "";
      });

      setupPackageJson({ build: "tsc -b", verify: "biome check .", test: "vitest run" });

      mockExec.mockRejectedValueOnce(Object.assign(new Error("build error"), { exitCode: 1 }));

      await run();

      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "false");
    });

    it("stops at verify failure without running test", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "run_tests") return "true";
        return "";
      });

      setupPackageJson({ build: "tsc -b", verify: "biome check .", test: "vitest run" });

      // Build succeeds, verify fails
      mockExec.mockResolvedValueOnce(0);
      mockExec.mockRejectedValueOnce(Object.assign(new Error("verify error"), { exitCode: 1 }));

      await run();

      expect(mockExec).toHaveBeenCalledTimes(2);
      expect(mockSetOutput).toHaveBeenCalledWith("build_success", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("verify_success", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("test_success", "false");
    });
  });

  describe("error handling", () => {
    it("calls setFailed with Error message", async () => {
      mockDetectPackageManager.mockImplementation(() => {
        throw new Error("detect failed");
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("detect failed");
    });

    it("calls setFailed with generic message on non-Error", async () => {
      mockDetectPackageManager.mockImplementation(() => {
        throw "string error";
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
    });
  });

  describe("package manager integration", () => {
    it("uses npm run command for npm package manager", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "npm";
        return "";
      });
      mockDetectPackageManager.mockReturnValue({
        packageManager: "npm",
        hasLockfile: true,
      });
      mockGetRunCommand.mockImplementation((_pm: string, script: string) => `npm run ${script}`);

      setupPackageJson({ build: "tsc -b" });

      await run();

      expect(mockExec).toHaveBeenCalledWith("npm", ["run", "build"], expect.any(Object));
    });

    it("uses yarn run command for yarn package manager", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "yarn";
        return "";
      });
      mockDetectPackageManager.mockReturnValue({
        packageManager: "yarn",
        hasLockfile: true,
      });
      mockGetRunCommand.mockImplementation((_pm: string, script: string) => `yarn run ${script}`);

      setupPackageJson({ verify: "lint" });

      await run();

      expect(mockExec).toHaveBeenCalledWith("yarn", ["run", "verify"], expect.any(Object));
    });
  });
});
