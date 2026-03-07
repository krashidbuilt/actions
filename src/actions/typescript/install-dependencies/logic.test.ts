import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockExec, mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
}));

const { mockWorkingDirectory, mockDetectPackageManager, mockEnsureBunfig, mockEnsureNpmrc, mockGetInstallCommand } =
  vi.hoisted(() => ({
    mockWorkingDirectory: vi.fn(() => "."),
    mockDetectPackageManager: vi.fn(() => ({
      packageManager: "bun" as const,
      hasLockfile: true,
      lockfilePath: "/tmp/bun.lock",
      lockfileName: "bun.lock",
    })) as Mock,
    mockEnsureBunfig: vi.fn(() => ({ created: false, path: "/tmp/bunfig.toml" })) as Mock,
    mockEnsureNpmrc: vi.fn(() => ({ created: false, path: "/tmp/.npmrc" })) as Mock,
    mockGetInstallCommand: vi.fn((_pm: string, _frozen: boolean) => "bun install --frozen-lockfile") as Mock,
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
  ensureBunfig: mockEnsureBunfig,
  ensureNpmrc: mockEnsureNpmrc,
  getInstallCommand: mockGetInstallCommand,
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

describe("typescript/install-dependencies", () => {
  beforeEach(() => {
    mockGetInput.mockImplementation((_name: string) => "");
  });

  describe("getInputs", () => {
    it("defaults to auto package manager when no input", async () => {
      mockGetInput.mockImplementation((_name: string) => "");
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");

      await run();

      expect(mockDetectPackageManager).toHaveBeenCalled();
    });

    it("uses explicit package manager when provided", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "npm";
        return "";
      });
      mockGetInstallCommand.mockReturnValue("npm ci");

      await run();

      expect(mockDetectPackageManager).not.toHaveBeenCalled();
      expect(mockSetOutput).toHaveBeenCalledWith("package_manager", "npm");
    });

    it("throws on invalid package manager", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "pnpm";
        return "";
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("Invalid package manager: pnpm. Must be npm, yarn, bun, or auto.");
    });

    it("accepts bun as explicit package manager", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "bun";
        return "";
      });
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("package_manager", "bun");
    });

    it("accepts yarn as explicit package manager", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "yarn";
        return "";
      });
      mockGetInstallCommand.mockReturnValue("yarn install --immutable");

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("package_manager", "yarn");
    });

    it("treats frozen_lockfile as true by default", async () => {
      mockGetInput.mockImplementation((_name: string) => "");
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");

      await run();

      expect(mockGetInstallCommand).toHaveBeenCalledWith("bun", true);
    });

    it("disables frozen lockfile when set to false", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "frozen_lockfile") return "false";
        return "";
      });
      mockGetInstallCommand.mockReturnValue("bun install");

      await run();

      expect(mockGetInstallCommand).toHaveBeenCalledWith("bun", false);
    });
  });

  describe("registry config", () => {
    it("creates bunfig.toml for bun package manager when newly created", async () => {
      mockDetectPackageManager.mockReturnValue({
        packageManager: "bun",
        hasLockfile: true,
      });
      mockEnsureBunfig.mockReturnValue({ created: true, path: "/tmp/bunfig.toml" });
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");

      await run();

      expect(mockEnsureBunfig).toHaveBeenCalled();
      expect(mockEnsureNpmrc).not.toHaveBeenCalled();
    });

    it("creates .npmrc for npm package manager when newly created", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "npm";
        return "";
      });
      mockEnsureNpmrc.mockReturnValue({ created: true, path: "/tmp/.npmrc" });
      mockGetInstallCommand.mockReturnValue("npm ci");

      await run();

      expect(mockEnsureNpmrc).toHaveBeenCalled();
      expect(mockEnsureBunfig).not.toHaveBeenCalled();
    });

    it("creates .npmrc for yarn package manager", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "yarn";
        return "";
      });
      mockEnsureNpmrc.mockReturnValue({ created: false, path: "/tmp/.npmrc", reason: ".npmrc already exists" });
      mockGetInstallCommand.mockReturnValue("yarn install --immutable");

      await run();

      expect(mockEnsureNpmrc).toHaveBeenCalled();
      expect(mockEnsureBunfig).not.toHaveBeenCalled();
    });

    it("does not log creation when bunfig already exists", async () => {
      mockDetectPackageManager.mockReturnValue({
        packageManager: "bun",
        hasLockfile: true,
      });
      mockEnsureBunfig.mockReturnValue({ created: false, path: "/tmp/bunfig.toml", reason: "already exists" });
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");

      await run();

      expect(mockEnsureBunfig).toHaveBeenCalled();
    });
  });

  describe("install execution", () => {
    it("runs install command with correct working directory", async () => {
      mockWorkingDirectory.mockReturnValue("/my/project");
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");

      await run();

      expect(mockExec).toHaveBeenCalledWith("bun", ["install", "--frozen-lockfile"], {
        cwd: expect.stringContaining("my/project"),
      });
    });

    it("splits install command into cmd and args correctly", async () => {
      mockGetInstallCommand.mockReturnValue("npm ci");

      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "npm";
        return "";
      });

      await run();

      expect(mockExec).toHaveBeenCalledWith("npm", ["ci"], {
        cwd: expect.any(String),
      });
    });

    it("handles yarn install command", async () => {
      mockGetInstallCommand.mockReturnValue("yarn install --immutable");

      mockGetInput.mockImplementation((name: string) => {
        if (name === "package_manager") return "yarn";
        return "";
      });

      await run();

      expect(mockExec).toHaveBeenCalledWith("yarn", ["install", "--immutable"], {
        cwd: expect.any(String),
      });
    });
  });

  describe("error handling", () => {
    it("calls setFailed with Error message", async () => {
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");
      mockExec.mockRejectedValue(new Error("install failed"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("install failed");
    });

    it("calls setFailed with generic message on non-Error", async () => {
      mockGetInstallCommand.mockReturnValue("bun install --frozen-lockfile");
      mockExec.mockRejectedValue("string error");

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
    });

    it("handles detectPackageManager failure", async () => {
      mockDetectPackageManager.mockImplementation(() => {
        throw new Error("no lockfile");
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("no lockfile");
    });
  });
});
