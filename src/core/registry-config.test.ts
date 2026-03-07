import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureBunfig, ensureNpmrc, generateBunfigContent, generateNpmrcContent } from "./registry-config.js";

describe("generateNpmrcContent", () => {
  it("generates .npmrc with default scope and registry", () => {
    const content = generateNpmrcContent();
    expect(content).toContain("@krashidbuilt:registry=https://registry.npmjs.org/");
    expect(content).toContain("_authToken=");
    expect(content).toContain("NODE_AUTH_TOKEN");
  });

  it("generates .npmrc with custom scope and registry", () => {
    const content = generateNpmrcContent("@custom", "https://npm.pkg.github.com/");
    expect(content).toContain("@custom:registry=https://npm.pkg.github.com/");
  });
});

describe("generateBunfigContent", () => {
  it("generates bunfig.toml with default scope and registry", () => {
    const content = generateBunfigContent();
    expect(content).toContain("[install.scopes]");
    expect(content).toContain('"@krashidbuilt"');
    expect(content).toContain("https://registry.npmjs.org/");
    expect(content).toContain("$BUN_AUTH_TOKEN");
  });

  it("generates bunfig.toml with custom scope and registry", () => {
    const content = generateBunfigContent("@custom", "https://npm.pkg.github.com/");
    expect(content).toContain('"@custom"');
    expect(content).toContain("https://npm.pkg.github.com/");
  });
});

describe("ensureNpmrc", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "npmrc-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates .npmrc when it does not exist", () => {
    const result = ensureNpmrc(tempDir);
    expect(result.created).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });

  it("does not overwrite existing .npmrc", () => {
    writeFileSync(join(tempDir, ".npmrc"), "existing content");
    const result = ensureNpmrc(tempDir);
    expect(result.created).toBe(false);
    expect(result.reason).toBe(".npmrc already exists");
  });
});

describe("ensureBunfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bunfig-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates bunfig.toml when it does not exist", () => {
    const result = ensureBunfig(tempDir);
    expect(result.created).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });

  it("does not overwrite existing bunfig.toml", () => {
    writeFileSync(join(tempDir, "bunfig.toml"), "existing content");
    const result = ensureBunfig(tempDir);
    expect(result.created).toBe(false);
    expect(result.reason).toBe("bunfig.toml already exists");
  });
});
