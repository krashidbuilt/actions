import { describe, expect, it, type Mock, vi } from "vitest";

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
}));

const { mockReadPackageJson, mockExistsSync } = vi.hoisted(() => ({
  mockReadPackageJson: vi.fn(() => ({ version: "1.0.0" })) as Mock,
  mockExistsSync: vi.fn(() => true),
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
}));

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  isDebug: vi.fn(() => false),
}));

vi.mock("./package-json.js", () => ({
  readPackageJson: mockReadPackageJson,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: mockExistsSync,
  };
});

import {
  bumpVersion,
  determineBumpType,
  determineBumpTypeFromCommits,
  getLatestGitTag,
  getLatestPrereleaseTagForVersion,
  getVersionInfo,
  parseVersion,
  readPackageVersion,
  readProjectVersion,
  tagExists,
} from "./version.js";

describe("parseVersion", () => {
  it("parses stable versions", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
  });

  it("parses versions with v prefix", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
  });

  it("parses alpha prerelease versions", () => {
    expect(parseVersion("1.2.3-alpha.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "alpha.1" });
  });

  it("parses beta prerelease versions", () => {
    expect(parseVersion("v0.2.0-beta.5")).toEqual({ major: 0, minor: 2, patch: 0, prerelease: "beta.5" });
  });

  it("parses 0.x versions", () => {
    expect(parseVersion("0.0.1")).toEqual({ major: 0, minor: 0, patch: 1, prerelease: undefined });
  });

  it("throws for invalid version strings", () => {
    expect(() => parseVersion("invalid")).toThrow("Invalid version format");
    expect(() => parseVersion("1.2")).toThrow("Invalid version format");
    expect(() => parseVersion("")).toThrow("Invalid version format");
  });
});

describe("bumpVersion", () => {
  describe("stable bumps", () => {
    it("bumps patch version", () => {
      expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    });

    it("bumps minor version", () => {
      expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    });

    it("bumps major version", () => {
      expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    });
  });

  describe("prerelease bumps", () => {
    it("creates first alpha prerelease from stable", () => {
      expect(bumpVersion("1.2.3", "patch", { prerelease: true, prereleaseIdentifier: "alpha" })).toBe("1.2.4-alpha.1");
    });

    it("creates first beta prerelease from stable", () => {
      expect(bumpVersion("1.2.3", "minor", { prerelease: true, prereleaseIdentifier: "beta" })).toBe("1.3.0-beta.1");
    });

    it("increments existing alpha prerelease", () => {
      expect(bumpVersion("1.2.3-alpha.1", "patch", { prerelease: true, prereleaseIdentifier: "alpha" })).toBe(
        "1.2.3-alpha.2",
      );
    });

    it("increments existing beta prerelease", () => {
      expect(bumpVersion("1.2.3-beta.5", "patch", { prerelease: true, prereleaseIdentifier: "beta" })).toBe(
        "1.2.3-beta.6",
      );
    });

    it("creates new prerelease when identifier changes", () => {
      expect(bumpVersion("1.2.3-alpha.5", "patch", { prerelease: true, prereleaseIdentifier: "beta" })).toBe(
        "1.2.4-beta.1",
      );
    });

    it("creates major prerelease", () => {
      expect(bumpVersion("1.2.3", "major", { prerelease: true, prereleaseIdentifier: "alpha" })).toBe("2.0.0-alpha.1");
    });
  });

  describe("promoting prereleases to stable", () => {
    it("strips prerelease suffix when not in prerelease mode", () => {
      expect(bumpVersion("1.2.3-alpha.5", "patch")).toBe("1.2.3");
    });

    it("strips beta prerelease suffix", () => {
      expect(bumpVersion("2.0.0-beta.3", "major")).toBe("2.0.0");
    });
  });
});

describe("determineBumpType", () => {
  it("detects major bump", () => {
    expect(determineBumpType("1.0.0", "2.0.0")).toBe("major");
  });

  it("detects minor bump", () => {
    expect(determineBumpType("1.0.0", "1.1.0")).toBe("minor");
  });

  it("detects patch bump", () => {
    expect(determineBumpType("1.0.0", "1.0.1")).toBe("patch");
  });

  it("returns null when versions are equal", () => {
    expect(determineBumpType("1.0.0", "1.0.0")).toBeNull();
  });
});

describe("determineBumpTypeFromCommits", () => {
  it("returns none for empty commits", () => {
    expect(determineBumpTypeFromCommits([])).toBe("none");
  });

  it("detects major from BREAKING CHANGE", () => {
    expect(determineBumpTypeFromCommits(["abc123 feat: add feature", "def456 fix: BREAKING CHANGE something"])).toBe(
      "major",
    );
  });

  it("detects major from BREAKING-CHANGE", () => {
    expect(determineBumpTypeFromCommits(["abc123 BREAKING-CHANGE: new API"])).toBe("major");
  });

  it("detects major from ! in commit type", () => {
    expect(determineBumpTypeFromCommits(["abc123 feat!: breaking new feature"])).toBe("major");
  });

  it("detects minor from feat commits", () => {
    expect(determineBumpTypeFromCommits(["abc123 feat: add new feature", "def456 fix: small fix"])).toBe("minor");
  });

  it("detects minor from feat(scope) commits", () => {
    expect(determineBumpTypeFromCommits(["abc123 feat(web): add new page"])).toBe("minor");
  });

  it("detects patch for fix-only commits", () => {
    expect(determineBumpTypeFromCommits(["abc123 fix: small fix", "def456 chore: update deps"])).toBe("patch");
  });

  it("detects patch for chore/refactor commits", () => {
    expect(determineBumpTypeFromCommits(["abc123 chore: update config", "def456 refactor: clean up"])).toBe("patch");
  });
});

/** Helper to make mockExec simulate stdout output */
function mockGitTagOutput(output: string) {
  mockExec.mockImplementation(
    async (
      _cmd: string,
      _args: string[],
      options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean; ignoreReturnCode?: boolean },
    ) => {
      options?.listeners?.stdout?.(Buffer.from(output));
      return 0;
    },
  );
}

describe("readPackageVersion", () => {
  it("reads version from package.json in working directory", () => {
    mockReadPackageJson.mockReturnValue({ version: "2.1.0" });
    const result = readPackageVersion(".");
    expect(result).toBe("2.1.0");
  });

  it("throws when package.json has no version field", () => {
    mockReadPackageJson.mockReturnValue({ name: "mypackage" });
    expect(() => readPackageVersion(".")).toThrow("No version field found in package.json");
  });

  it("uses default working directory when none specified", () => {
    mockReadPackageJson.mockReturnValue({ version: "1.0.0" });
    readPackageVersion();
    expect(mockReadPackageJson).toHaveBeenCalled();
  });

  it("passes resolved directory to readPackageJson", () => {
    mockReadPackageJson.mockReturnValue({ version: "3.0.0" });
    readPackageVersion("packages/web");
    expect(mockReadPackageJson).toHaveBeenCalled();
    const result = readPackageVersion("packages/web");
    expect(result).toBe("3.0.0");
  });
});

describe("readProjectVersion", () => {
  it("reads version from package.json when it exists", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadPackageJson.mockReturnValue({ version: "1.5.0" });
    const result = readProjectVersion(".");
    expect(result).toBe("1.5.0");
  });

  it("throws when no package.json exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => readProjectVersion(".")).toThrow("No package.json found at");
  });

  it("uses default working directory when none specified", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadPackageJson.mockReturnValue({ version: "1.0.0" });
    const result = readProjectVersion();
    expect(result).toBe("1.0.0");
  });
});

describe("getLatestGitTag", () => {
  it("returns the first semver tag from sorted tag list", async () => {
    mockGitTagOutput("v1.2.3\nv1.2.2\nv1.1.0\n");
    const result = await getLatestGitTag();
    expect(result).toBe("v1.2.3");
  });

  it("returns semver tag without v prefix", async () => {
    mockGitTagOutput("1.2.3\n1.0.0\n");
    const result = await getLatestGitTag();
    expect(result).toBe("1.2.3");
  });

  it("returns prerelease tag when stableOnly is false", async () => {
    mockGitTagOutput("v2.0.0-alpha.1\nv1.2.3\n");
    const result = await getLatestGitTag(false);
    expect(result).toBe("v2.0.0-alpha.1");
  });

  it("skips prerelease tags when stableOnly is true", async () => {
    mockGitTagOutput("v2.0.0-alpha.1\nv1.2.3\nv1.2.2\n");
    const result = await getLatestGitTag(true);
    expect(result).toBe("v1.2.3");
  });

  it("returns null when no semver tags exist", async () => {
    mockGitTagOutput("not-a-version\nrelease-candidate\n");
    const result = await getLatestGitTag();
    expect(result).toBeNull();
  });

  it("returns null when no stable tags exist and stableOnly is true", async () => {
    mockGitTagOutput("v2.0.0-alpha.1\nv2.0.0-beta.1\n");
    const result = await getLatestGitTag(true);
    expect(result).toBeNull();
  });

  it("returns null when tag output is empty", async () => {
    mockGitTagOutput("");
    const result = await getLatestGitTag();
    expect(result).toBeNull();
  });

  it("returns null when exec throws", async () => {
    mockExec.mockRejectedValueOnce(new Error("git not found"));
    const result = await getLatestGitTag();
    expect(result).toBeNull();
  });
});

describe("getLatestPrereleaseTagForVersion", () => {
  it("finds latest alpha prerelease tag for a base version", async () => {
    mockGitTagOutput("v1.2.3-alpha.5\nv1.2.3-alpha.3\nv1.2.3-alpha.1\n");
    const result = await getLatestPrereleaseTagForVersion("1.2.3", "alpha");
    expect(result).toBe("v1.2.3-alpha.5");
  });

  it("defaults to alpha identifier", async () => {
    mockGitTagOutput("v1.0.0-alpha.2\nv1.0.0-alpha.1\n");
    const result = await getLatestPrereleaseTagForVersion("1.0.0");
    expect(result).toBe("v1.0.0-alpha.2");
  });

  it("finds beta prerelease tag", async () => {
    mockGitTagOutput("v2.0.0-beta.3\nv2.0.0-beta.2\nv2.0.0-alpha.5\n");
    const result = await getLatestPrereleaseTagForVersion("2.0.0", "beta");
    expect(result).toBe("v2.0.0-beta.3");
  });

  it("normalizes version with v prefix", async () => {
    mockGitTagOutput("v1.0.0-alpha.1\n");
    const result = await getLatestPrereleaseTagForVersion("v1.0.0", "alpha");
    expect(result).toBe("v1.0.0-alpha.1");
  });

  it("returns null when no matching prerelease tags", async () => {
    mockGitTagOutput("v2.0.0-alpha.1\nv1.0.0\n");
    const result = await getLatestPrereleaseTagForVersion("1.0.0", "beta");
    expect(result).toBeNull();
  });

  it("returns null when no tags at all", async () => {
    mockGitTagOutput("");
    const result = await getLatestPrereleaseTagForVersion("1.0.0");
    expect(result).toBeNull();
  });

  it("returns null when exec throws", async () => {
    mockExec.mockRejectedValueOnce(new Error("git not found"));
    const result = await getLatestPrereleaseTagForVersion("1.0.0");
    expect(result).toBeNull();
  });
});

describe("tagExists", () => {
  it("returns true when tag exists locally", async () => {
    mockExec.mockImplementation(async () => 0);
    const result = await tagExists("v1.0.0");
    expect(result).toBe(true);
  });

  it("checks remote when tag does not exist locally", async () => {
    let callCount = 0;
    mockExec.mockImplementation(
      async (
        _cmd: string,
        _args: string[],
        options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean; ignoreReturnCode?: boolean },
      ) => {
        callCount++;
        if (callCount === 1) {
          // local rev-parse returns non-zero
          return 1;
        }
        // remote ls-remote returns output
        options?.listeners?.stdout?.(Buffer.from("abc123\trefs/tags/v1.0.0\n"));
        return 0;
      },
    );
    const result = await tagExists("v1.0.0");
    expect(result).toBe(true);
  });

  it("returns false when tag does not exist locally or remotely", async () => {
    let callCount = 0;
    mockExec.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return 1; // local check fails
      }
      return 0; // remote check succeeds but no output
    });
    const result = await tagExists("v1.0.0");
    expect(result).toBe(false);
  });

  it("returns false when remote check returns non-zero exit code", async () => {
    let callCount = 0;
    mockExec.mockImplementation(
      async (
        _cmd: string,
        _args: string[],
        options?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean; ignoreReturnCode?: boolean },
      ) => {
        callCount++;
        if (callCount === 1) {
          return 1; // local fails
        }
        options?.listeners?.stdout?.(Buffer.from("some output"));
        return 1; // remote fails
      },
    );
    const result = await tagExists("v1.0.0");
    expect(result).toBe(false);
  });

  it("returns false when exec throws", async () => {
    mockExec.mockRejectedValueOnce(new Error("git error"));
    const result = await tagExists("v1.0.0");
    expect(result).toBe(false);
  });

  it("uses correct git commands for local and remote checks", async () => {
    let callCount = 0;
    mockExec.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? 1 : 0;
    });
    await tagExists("v2.0.0");

    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "refs/tags/v2.0.0"],
      expect.objectContaining({ silent: true, ignoreReturnCode: true }),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "git",
      ["ls-remote", "--tags", "origin", "v2.0.0"],
      expect.objectContaining({ silent: true, ignoreReturnCode: true }),
    );
  });
});

describe("getVersionInfo", () => {
  it("returns version info with latest tag", async () => {
    mockReadPackageJson.mockReturnValue({ version: "1.2.3" });
    mockGitTagOutput("v1.2.2\nv1.2.1\n");

    const result = await getVersionInfo(".");
    expect(result).toEqual({
      current: "1.2.3",
      previous: "1.2.2",
      tag: "v1.2.3",
      isPrerelease: false,
    });
  });

  it("returns version info with no previous tag", async () => {
    mockReadPackageJson.mockReturnValue({ version: "0.1.0" });
    mockGitTagOutput("");

    const result = await getVersionInfo(".");
    expect(result).toEqual({
      current: "0.1.0",
      previous: undefined,
      tag: "v0.1.0",
      isPrerelease: false,
    });
  });

  it("detects prerelease version", async () => {
    mockReadPackageJson.mockReturnValue({ version: "2.0.0-alpha.1" });
    mockGitTagOutput("v1.0.0\n");

    const result = await getVersionInfo(".");
    expect(result).toEqual({
      current: "2.0.0-alpha.1",
      previous: "1.0.0",
      tag: "v2.0.0-alpha.1",
      isPrerelease: true,
    });
  });

  it("strips v prefix from previous tag", async () => {
    mockReadPackageJson.mockReturnValue({ version: "1.0.1" });
    mockGitTagOutput("v1.0.0\n");

    const result = await getVersionInfo(".");
    expect(result.previous).toBe("1.0.0");
  });

  it("uses default working directory", async () => {
    mockReadPackageJson.mockReturnValue({ version: "1.0.0" });
    mockGitTagOutput("");

    const result = await getVersionInfo();
    expect(result.current).toBe("1.0.0");
  });
});
