import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockExec, mockSetOutput, mockSetFailed, mockAddPath, mockExportVariable } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockAddPath: vi.fn(),
  mockExportVariable: vi.fn(),
}));

const { mockFind, mockDownloadTool, mockExtractTar, mockExtractZip, mockCacheDir } = vi.hoisted(() => ({
  mockFind: vi.fn((_name: string, _version: string) => ""),
  mockDownloadTool: vi.fn(async () => "/tmp/download"),
  mockExtractTar: vi.fn(async () => "/tmp/extracted"),
  mockExtractZip: vi.fn(async () => "/tmp/extracted"),
  mockCacheDir: vi.fn(async () => "/tmp/cached"),
}));

const {
  mockNodeVersion,
  mockBunVersion,
  mockWorkingDirectory,
  mockAuthToken,
  mockRegistryUrl,
  mockRegistryScope,
  mockDetectPackageManager,
} = vi.hoisted(() => ({
  mockNodeVersion: vi.fn(() => "22"),
  mockBunVersion: vi.fn(() => "1.3.5"),
  mockWorkingDirectory: vi.fn(() => "."),
  mockAuthToken: vi.fn(() => ""),
  mockRegistryUrl: vi.fn(() => "https://registry.npmjs.org/"),
  mockRegistryScope: vi.fn(() => "@krashidbuilt"),
  mockDetectPackageManager: vi.fn(() => ({
    packageManager: "bun" as const,
    hasLockfile: true,
    lockfilePath: "/tmp/bun.lock",
    lockfileName: "bun.lock",
  })),
}));

const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  addPath: mockAddPath,
  exportVariable: mockExportVariable,
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

vi.mock("@actions/tool-cache", () => ({
  find: mockFind,
  downloadTool: mockDownloadTool,
  extractTar: mockExtractTar,
  extractZip: mockExtractZip,
  cacheDir: mockCacheDir,
}));

vi.mock("../../../core/index.js", () => ({
  common: { workingDirectory: mockWorkingDirectory },
  runtime: { nodeVersion: mockNodeVersion, bunVersion: mockBunVersion },
  registry: { authToken: mockAuthToken, url: mockRegistryUrl, scope: mockRegistryScope },
  detectPackageManager: mockDetectPackageManager,
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

describe("typescript/setup", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("run", () => {
    it("detects package manager and sets output", async () => {
      // Node already installed at matching version
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      await run();

      expect(mockDetectPackageManager).toHaveBeenCalled();
      expect(mockSetOutput).toHaveBeenCalledWith("package_manager", "bun");
    });

    it("sets node_version and bun_version outputs", async () => {
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("node_version", "v22.5.0");
      expect(mockSetOutput).toHaveBeenCalledWith("bun_version", "1.3.5");
    });

    it("configures registry when auth token is provided", async () => {
      mockAuthToken.mockReturnValue("my-token");

      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if ((cmd === "node" || cmd === "bun") && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.0.0"));
          }
          return 0;
        },
      );

      await run();

      expect(mockExportVariable).toHaveBeenCalledWith("NODE_AUTH_TOKEN", "my-token");
      expect(mockExportVariable).toHaveBeenCalledWith("BUN_AUTH_TOKEN", "my-token");
      expect(mockExec).toHaveBeenCalledWith("npm", [
        "config",
        "set",
        "@krashidbuilt:registry",
        "https://registry.npmjs.org/",
      ]);
      expect(mockExec).toHaveBeenCalledWith("npm", ["config", "set", "//registry.npmjs.org/:_authToken", "my-token"]);
    });

    it("skips registry configuration when no auth token", async () => {
      mockAuthToken.mockReturnValue("");

      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if ((cmd === "node" || cmd === "bun") && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.0.0"));
          }
          return 0;
        },
      );

      await run();

      expect(mockExportVariable).not.toHaveBeenCalledWith("NODE_AUTH_TOKEN", expect.anything());
    });

    it("calls setFailed with error message on Error", async () => {
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

  describe("setupNode", () => {
    it("skips installation when Node.js major version matches", async () => {
      mockNodeVersion.mockReturnValue("22");

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ version: "v22.5.1", lts: "Iron" }],
      });

      let _execCallCount = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          _execCallCount++;
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.3.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      await run();

      // Node --version called once (check), not downloading
      expect(mockFind).not.toHaveBeenCalled();
      expect(mockDownloadTool).not.toHaveBeenCalled();
    });

    it("installs Node.js when current version does not match", async () => {
      mockNodeVersion.mockReturnValue("24");

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [
          { version: "v24.1.0", lts: false },
          { version: "v22.5.1", lts: "Iron" },
        ],
      });

      // First exec: node --version check returns v22
      // Second exec: bun --version check returns 1.3.5
      let nodeCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            nodeCallIndex++;
            if (nodeCallIndex === 1) {
              // Current version check: major mismatch
              options?.listeners?.stdout?.(Buffer.from("v22.3.0"));
            } else {
              // After install
              options?.listeners?.stdout?.(Buffer.from("v24.1.0"));
            }
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      mockFind.mockReturnValue("");
      mockCacheDir.mockResolvedValue("/tmp/cached");

      await run();

      expect(mockDownloadTool).toHaveBeenCalled();
      expect(mockAddPath).toHaveBeenCalled();
    });

    it("uses tool cache when Node.js is already cached", async () => {
      mockNodeVersion.mockReturnValue("22");

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ version: "v22.5.1", lts: "Iron" }],
      });

      // node --version check fails (not installed)
      let nodeCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            nodeCallIndex++;
            if (nodeCallIndex === 1) {
              throw new Error("node not found");
            }
            options?.listeners?.stdout?.(Buffer.from("v22.5.1"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      mockFind.mockReturnValueOnce("/cached/node");

      await run();

      expect(mockFind).toHaveBeenCalledWith("node", "22.5.1");
      expect(mockDownloadTool).not.toHaveBeenCalled();
      expect(mockAddPath).toHaveBeenCalled();
    });

    it("resolves exact semver version without fetching", async () => {
      mockNodeVersion.mockReturnValue("22.5.1");

      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.1"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      await run();

      // Should NOT fetch nodejs.org versions because input is exact semver
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls back to version.0.0 when fetch fails", async () => {
      mockNodeVersion.mockReturnValue("24");

      mockFetch.mockRejectedValue(new Error("network error"));

      let nodeCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            nodeCallIndex++;
            if (nodeCallIndex === 1) {
              throw new Error("node not found");
            }
            options?.listeners?.stdout?.(Buffer.from("v24.0.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      mockFind.mockReturnValue("/cached/node");

      await run();

      // Falls back to "24.0.0"
      expect(mockFind).toHaveBeenCalledWith("node", "24.0.0");
    });

    it("falls back to version.0.0 when no matching version found", async () => {
      mockNodeVersion.mockReturnValue("99");

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => [{ version: "v22.5.1", lts: "Iron" }],
      });

      let nodeCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            nodeCallIndex++;
            if (nodeCallIndex === 1) {
              throw new Error("node not found");
            }
            options?.listeners?.stdout?.(Buffer.from("v99.0.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      mockFind.mockReturnValue("/cached/node");

      await run();

      // No v99 in the list, falls back to "99.0.0"
      expect(mockFind).toHaveBeenCalledWith("node", "99.0.0");
    });
  });

  describe("setupBun", () => {
    it("skips installation when Bun version matches", async () => {
      mockBunVersion.mockReturnValue("1.3.5");

      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      await run();

      // bun --version returns matching major, so no download
      expect(mockFind).not.toHaveBeenCalledWith("bun", expect.anything());
    });

    it("installs Bun when current version does not match", async () => {
      mockBunVersion.mockReturnValue("1.4.0");

      let bunCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            bunCallIndex++;
            if (bunCallIndex === 1) {
              // Current version check: doesn't match requested major start
              options?.listeners?.stdout?.(Buffer.from("0.9.0"));
            } else {
              options?.listeners?.stdout?.(Buffer.from("1.4.0"));
            }
          }
          return 0;
        },
      );

      mockFind.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);

      await run();

      expect(mockDownloadTool).toHaveBeenCalled();
      expect(mockExtractZip).toHaveBeenCalled();
    });

    it("installs Bun when bun is not found at all", async () => {
      mockBunVersion.mockReturnValue("1.3.5");

      let bunCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            bunCallIndex++;
            if (bunCallIndex === 1) {
              throw new Error("bun not found");
            }
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      mockFind.mockReturnValue("/cached/bun");

      await run();

      expect(mockFind).toHaveBeenCalledWith("bun", "1.3.5");
      expect(mockAddPath).toHaveBeenCalledWith("/cached/bun");
    });

    it("uses extractedPath directly when bunDir does not exist", async () => {
      mockBunVersion.mockReturnValue("1.3.5");

      let bunCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            bunCallIndex++;
            if (bunCallIndex === 1) {
              throw new Error("bun not found");
            }
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      mockFind.mockReturnValue("");
      mockExistsSync.mockReturnValue(false);
      mockCacheDir.mockResolvedValue("/tmp/cached-bun");

      await run();

      // When bunDir doesn't exist, cacheDir is called with extractedPath directly
      expect(mockCacheDir).toHaveBeenCalledWith("/tmp/extracted", "bun", "1.3.5");
    });

    it("uses bunDir when it exists", async () => {
      mockBunVersion.mockReturnValue("1.3.5");

      let bunCallIndex = 0;
      mockExec.mockImplementation(
        async (
          cmd: string,
          args?: string[],
          options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (cmd === "node" && args?.[0] === "--version") {
            options?.listeners?.stdout?.(Buffer.from("v22.5.0"));
          }
          if (cmd === "bun" && args?.[0] === "--version") {
            bunCallIndex++;
            if (bunCallIndex === 1) {
              throw new Error("bun not found");
            }
            options?.listeners?.stdout?.(Buffer.from("1.3.5"));
          }
          return 0;
        },
      );

      mockFind.mockReturnValue("");
      mockExistsSync.mockReturnValue(true);
      mockCacheDir.mockResolvedValue("/tmp/cached-bun");

      await run();

      // When bunDir exists, cacheDir is called with the bunDir path
      expect(mockCacheDir).toHaveBeenCalledWith(expect.stringContaining("bun-"), "bun", "1.3.5");
    });
  });
});
