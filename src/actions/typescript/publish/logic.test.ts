import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockExec, mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
}));

const { mockWorkingDirectory, mockDetectPackageManager, mockGetRunCommand, mockReadPackageJson } = vi.hoisted(() => ({
  mockWorkingDirectory: vi.fn(() => "."),
  mockDetectPackageManager: vi.fn(() => ({
    packageManager: "bun" as const,
    hasLockfile: true,
    lockfilePath: "/tmp/bun.lock",
    lockfileName: "bun.lock",
  })) as Mock,
  mockGetRunCommand: vi.fn((_pm: string, script: string) => `bun run ${script}`) as Mock,
  mockReadPackageJson: vi.fn(() => ({
    name: "@krashidbuilt/my-pkg",
    version: "1.0.0",
    scripts: { build: "tsc -b" },
  })) as Mock,
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
  readPackageJson: mockReadPackageJson,
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

describe("typescript/publish", () => {
  beforeEach(() => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "tag") return "latest";
      return "";
    });
  });

  describe("getInputs", () => {
    it("reads tag input", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "tag") return "alpha";
        return "";
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("tag", "alpha");
    });

    it("defaults skip_build to false", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: { build: "tsc -b" },
      });

      await run();

      // Build should run (skip_build is not "true")
      expect(mockExec).toHaveBeenCalledWith("bun", ["run", "build"], expect.any(Object));
    });

    it("skips build when skip_build is true", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "tag") return "latest";
        if (name === "skip_build") return "true";
        return "";
      });

      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: { build: "tsc -b" },
      });

      await run();

      // Build should NOT run
      const buildCalls = mockExec.mock.calls.filter((call) => call[0] === "bun" && call[1]?.[1] === "build");
      expect(buildCalls).toHaveLength(0);
    });
  });

  describe("use_oidc", () => {
    it("publishes with provenance and strips NODE_AUTH_TOKEN by default", async () => {
      process.env.NODE_AUTH_TOKEN = "should-not-reach-npm";

      await run();

      const publishCall = mockExec.mock.calls.find((call) => call[1]?.[0] === "publish");
      expect(publishCall?.[1]).toEqual(["publish", "--provenance", "--access", "public", "--tag", "latest"]);
      expect(publishCall?.[2]?.env).toBeDefined();
      expect(publishCall?.[2]?.env?.NODE_AUTH_TOKEN).toBeUndefined();
      expect(publishCall?.[2]?.env?.BUN_AUTH_TOKEN).toBeUndefined();

      delete process.env.NODE_AUTH_TOKEN;
    });

    it("publishes with the registry token and no npmjs-only flags when use_oidc is false", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "tag") return "latest";
        if (name === "use_oidc") return "false";
        return "";
      });

      await run();

      const publishCall = mockExec.mock.calls.find((call) => call[1]?.[0] === "publish");
      // --provenance and --access are npmjs-only; Gitea's registry rejects them.
      expect(publishCall?.[1]).toEqual(["publish", "--tag", "latest"]);
      // No env override, so NODE_AUTH_TOKEN from the runner survives and authenticates.
      expect(publishCall?.[2]).toEqual({ cwd: expect.any(String) });
    });

    it("still reports the published version on the token path", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "tag") return "alpha";
        if (name === "use_oidc") return "false";
        return "";
      });
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/googlecli",
        version: "0.12.0",
        scripts: {},
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("published", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "0.12.0");
      expect(mockSetOutput).toHaveBeenCalledWith("tag", "alpha");
    });
  });

  describe("build step", () => {
    it("runs build when skip_build is false and build script exists", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: { build: "tsc -b" },
      });

      await run();

      expect(mockExec).toHaveBeenCalledWith("bun", ["run", "build"], {
        cwd: expect.any(String),
      });
    });

    it("skips build when package.json has no build script", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: {},
      });

      await run();

      const buildCalls = mockExec.mock.calls.filter((call) => call[0] === "bun" && call[1]?.[1] === "build");
      expect(buildCalls).toHaveLength(0);
    });

    it("skips build when package.json has no scripts property", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
      });

      await run();

      const buildCalls = mockExec.mock.calls.filter((call) => call[0] === "bun" && call[1]?.[1] === "build");
      expect(buildCalls).toHaveLength(0);
    });

    it("uses detected package manager for build command", async () => {
      mockDetectPackageManager.mockReturnValue({
        packageManager: "npm",
        hasLockfile: true,
      });
      mockGetRunCommand.mockReturnValue("npm run build");

      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: { build: "tsc -b" },
      });

      await run();

      expect(mockGetRunCommand).toHaveBeenCalledWith("npm", "build");
      expect(mockExec).toHaveBeenCalledWith("npm", ["run", "build"], expect.any(Object));
    });
  });

  describe("publish step", () => {
    it("publishes with npm using provenance and correct tag", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "2.0.0",
        scripts: {},
      });

      mockGetInput.mockImplementation((name: string) => {
        if (name === "tag") return "beta";
        return "";
      });

      await run();

      expect(mockExec).toHaveBeenCalledWith(
        "npm",
        ["publish", "--provenance", "--access", "public", "--tag", "beta"],
        expect.objectContaining({
          cwd: expect.any(String),
          env: expect.any(Object),
        }),
      );
    });

    it("strips NODE_AUTH_TOKEN from publish environment", async () => {
      // Set env vars that should be stripped
      const originalNodeAuth = process.env.NODE_AUTH_TOKEN;
      const originalBunAuth = process.env.BUN_AUTH_TOKEN;
      process.env.NODE_AUTH_TOKEN = "should-be-stripped";
      process.env.BUN_AUTH_TOKEN = "should-also-be-stripped";

      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: {},
      });

      await run();

      const publishCall = mockExec.mock.calls.find((call) => call[0] === "npm" && call[1]?.[0] === "publish");
      expect(publishCall).toBeDefined();
      const env = publishCall![2]?.env as Record<string, string>;
      expect(env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(env.BUN_AUTH_TOKEN).toBeUndefined();

      // Restore
      if (originalNodeAuth !== undefined) {
        process.env.NODE_AUTH_TOKEN = originalNodeAuth;
      } else {
        delete process.env.NODE_AUTH_TOKEN;
      }
      if (originalBunAuth !== undefined) {
        process.env.BUN_AUTH_TOKEN = originalBunAuth;
      } else {
        delete process.env.BUN_AUTH_TOKEN;
      }
    });

    it("preserves other environment variables in publish env", async () => {
      const originalPath = process.env.PATH;

      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: {},
      });

      await run();

      const publishCall = mockExec.mock.calls.find((call) => call[0] === "npm" && call[1]?.[0] === "publish");
      const env = publishCall![2]?.env as Record<string, string>;
      expect(env.PATH).toBe(originalPath);
    });
  });

  describe("outputs", () => {
    it("sets published, version, and tag outputs on success", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "3.1.4",
        scripts: {},
      });

      mockGetInput.mockImplementation((name: string) => {
        if (name === "tag") return "latest";
        return "";
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("published", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "3.1.4");
      expect(mockSetOutput).toHaveBeenCalledWith("tag", "latest");
    });

    it("uses 'unknown' when version is missing from package.json", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        scripts: {},
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "unknown");
    });
  });

  describe("error handling", () => {
    it("calls setFailed with Error message on publish failure", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: {},
      });

      mockExec.mockRejectedValue(new Error("npm publish failed: 403 Forbidden"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("npm publish failed: 403 Forbidden");
    });

    it("calls setFailed with generic message on non-Error", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: {},
      });

      mockExec.mockRejectedValue("string error");

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
    });

    it("calls setFailed when readPackageJson throws", async () => {
      mockReadPackageJson.mockImplementation(() => {
        throw new Error("package.json not found at /tmp/package.json");
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("package.json not found at /tmp/package.json");
    });

    it("calls setFailed when build step fails", async () => {
      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/pkg",
        version: "1.0.0",
        scripts: { build: "tsc -b" },
      });

      // Build exec call fails
      mockExec.mockRejectedValueOnce(new Error("build compilation error"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("build compilation error");
    });
  });

  describe("working directory", () => {
    it("uses resolved working directory for all operations", async () => {
      mockWorkingDirectory.mockReturnValue("packages/my-lib");

      mockReadPackageJson.mockReturnValue({
        name: "@krashidbuilt/my-lib",
        version: "1.0.0",
        scripts: { build: "tsc -b" },
      });

      await run();

      expect(mockReadPackageJson).toHaveBeenCalledWith(expect.stringContaining("packages/my-lib"));
      expect(mockDetectPackageManager).toHaveBeenCalledWith(
        expect.stringContaining("packages/my-lib"),
        expect.any(Object),
      );

      // Build call
      expect(mockExec).toHaveBeenCalledWith("bun", ["run", "build"], {
        cwd: expect.stringContaining("packages/my-lib"),
      });

      // Publish call
      expect(mockExec).toHaveBeenCalledWith(
        "npm",
        ["publish", "--provenance", "--access", "public", "--tag", "latest"],
        expect.objectContaining({
          cwd: expect.stringContaining("packages/my-lib"),
        }),
      );
    });
  });
});
