import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

import { detectPackageManager, getInstallCommand, getRunCommand } from "./package-manager.js";

describe("detectPackageManager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pm-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("detects bun from bun.lock", () => {
    writeFileSync(join(tempDir, "bun.lock"), "");
    const result = detectPackageManager(tempDir);
    expect(result.packageManager).toBe("bun");
    expect(result.hasLockfile).toBe(true);
    expect(result.lockfileName).toBe("bun.lock");
  });

  it("detects bun from bun.lockb", () => {
    writeFileSync(join(tempDir, "bun.lockb"), "");
    const result = detectPackageManager(tempDir);
    expect(result.packageManager).toBe("bun");
    expect(result.hasLockfile).toBe(true);
    expect(result.lockfileName).toBe("bun.lockb");
  });

  it("detects yarn from yarn.lock", () => {
    writeFileSync(join(tempDir, "yarn.lock"), "");
    const result = detectPackageManager(tempDir);
    expect(result.packageManager).toBe("yarn");
    expect(result.hasLockfile).toBe(true);
  });

  it("detects npm from package-lock.json", () => {
    writeFileSync(join(tempDir, "package-lock.json"), "");
    const result = detectPackageManager(tempDir);
    expect(result.packageManager).toBe("npm");
    expect(result.hasLockfile).toBe(true);
  });

  it("prefers bun over yarn when both exist", () => {
    writeFileSync(join(tempDir, "bun.lock"), "");
    writeFileSync(join(tempDir, "yarn.lock"), "");
    const result = detectPackageManager(tempDir);
    expect(result.packageManager).toBe("bun");
  });

  it("prefers yarn over npm when both exist", () => {
    writeFileSync(join(tempDir, "yarn.lock"), "");
    writeFileSync(join(tempDir, "package-lock.json"), "");
    const result = detectPackageManager(tempDir);
    expect(result.packageManager).toBe("yarn");
  });

  it("throws when no lockfile found", () => {
    expect(() => detectPackageManager(tempDir)).toThrow("Unable to detect package manager");
  });

  it("defaults to bun with allowNoLockfile", () => {
    const result = detectPackageManager(tempDir, { allowNoLockfile: true });
    expect(result.packageManager).toBe("bun");
    expect(result.hasLockfile).toBe(false);
  });

  it("uses hint when lockfile exists", () => {
    writeFileSync(join(tempDir, "yarn.lock"), "");
    const result = detectPackageManager(tempDir, { hint: "yarn" });
    expect(result.packageManager).toBe("yarn");
    expect(result.hasLockfile).toBe(true);
  });

  it("uses hint without lockfile", () => {
    const result = detectPackageManager(tempDir, { hint: "npm" });
    expect(result.packageManager).toBe("npm");
    expect(result.hasLockfile).toBe(false);
  });
});

describe("getInstallCommand", () => {
  it("returns frozen install for bun", () => {
    expect(getInstallCommand("bun")).toBe("bun install --frozen-lockfile");
  });

  it("returns non-frozen install for bun", () => {
    expect(getInstallCommand("bun", false)).toBe("bun install");
  });

  it("returns frozen install for yarn", () => {
    expect(getInstallCommand("yarn")).toBe("yarn install --immutable");
  });

  it("returns non-frozen install for yarn", () => {
    expect(getInstallCommand("yarn", false)).toBe("yarn install");
  });

  it("returns ci for npm frozen", () => {
    expect(getInstallCommand("npm")).toBe("npm ci");
  });

  it("returns install for npm non-frozen", () => {
    expect(getInstallCommand("npm", false)).toBe("npm install");
  });
});

describe("getRunCommand", () => {
  it("returns bun run command", () => {
    expect(getRunCommand("bun", "build")).toBe("bun run build");
  });

  it("returns yarn run command", () => {
    expect(getRunCommand("yarn", "test")).toBe("yarn run test");
  });

  it("returns npm run command", () => {
    expect(getRunCommand("npm", "verify")).toBe("npm run verify");
  });
});
