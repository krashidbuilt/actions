import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPackageJson, stripScope, tryReadPackageJson } from "./package-json.js";

describe("readPackageJson", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pkgjson-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and parses package.json", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "@krashidbuilt/ctrl",
        version: "1.2.3",
        scripts: { build: "tsc" },
      }),
    );

    const pkg = readPackageJson(tempDir);
    expect(pkg.name).toBe("@krashidbuilt/ctrl");
    expect(pkg.version).toBe("1.2.3");
    expect(pkg.scripts?.build).toBe("tsc");
  });

  it("throws when package.json does not exist", () => {
    expect(() => readPackageJson(tempDir)).toThrow("package.json not found");
  });
});

describe("tryReadPackageJson", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pkgjson-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns package.json when it exists", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "test" }));
    const pkg = tryReadPackageJson(tempDir);
    expect(pkg).not.toBeNull();
    expect(pkg?.name).toBe("test");
  });

  it("returns null when package.json does not exist", () => {
    const pkg = tryReadPackageJson(tempDir);
    expect(pkg).toBeNull();
  });
});

describe("stripScope", () => {
  it("strips npm scope from package name", () => {
    expect(stripScope("@krashidbuilt/ctrl")).toBe("ctrl");
  });

  it("strips any scope", () => {
    expect(stripScope("@karaconnect/actions")).toBe("actions");
  });

  it("returns unscoped name as-is", () => {
    expect(stripScope("ctrl")).toBe("ctrl");
  });

  it("handles empty string", () => {
    expect(stripScope("")).toBe("");
  });
});
