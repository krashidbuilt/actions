import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockGetInput, mockSetOutput, mockSetFailed, mockInfo } = vi.hoisted(() => ({
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  isDebug: vi.fn(() => false),
}));

const { mockExecExec } = vi.hoisted(() => ({
  mockExecExec: vi.fn(async () => 0) as Mock,
}));

vi.mock("@actions/exec", () => ({
  exec: mockExecExec,
}));

const { mockGetOctokit, mockContextRepo } = vi.hoisted(() => ({
  mockGetOctokit: vi.fn(),
  mockContextRepo: { owner: "krashidbuilt", repo: "ctrl" },
}));

vi.mock("@actions/github", () => ({
  getOctokit: mockGetOctokit,
  context: {
    repo: mockContextRepo,
  },
}));

const {
  mockBumpVersion,
  mockCommonWorkingDirectory,
  mockConfigureGitIdentity,
  mockDetermineBumpTypeFromCommits,
  mockGetLatestGitTag,
  mockGetLatestPrereleaseTagForVersion,
  mockGitUserName,
  mockGitUserEmail,
  mockParseVersion,
  mockReadProjectVersion,
  mockTagExists,
  mockLoggerInfo,
} = vi.hoisted(() => ({
  mockBumpVersion: vi.fn((_current: string, _bump: string) => "1.1.0") as Mock,
  mockCommonWorkingDirectory: vi.fn(() => "."),
  mockConfigureGitIdentity: vi.fn(async () => {}),
  mockDetermineBumpTypeFromCommits: vi.fn((_commits: string[]) => "patch" as const) as Mock,
  mockGetLatestGitTag: vi.fn(async () => null as string | null),
  mockGetLatestPrereleaseTagForVersion: vi.fn(async () => null as string | null),
  mockGitUserName: vi.fn(() => "github-actions[bot]"),
  mockGitUserEmail: vi.fn(() => "github-actions[bot]@users.noreply.github.com"),
  mockParseVersion: vi.fn((v: string) => {
    const normalized = v.replace(/^v/, "");
    const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) throw new Error(`Invalid version format: ${v}`);
    return {
      major: Number.parseInt(match[1], 10),
      minor: Number.parseInt(match[2], 10),
      patch: Number.parseInt(match[3], 10),
      prerelease: match[4],
    };
  }),
  mockReadProjectVersion: vi.fn(() => "1.0.0"),
  mockTagExists: vi.fn(async () => false),
  mockLoggerInfo: vi.fn(),
}));

vi.mock("../../core/index.js", () => ({
  bumpVersion: mockBumpVersion,
  common: { workingDirectory: mockCommonWorkingDirectory },
  configureGitIdentity: mockConfigureGitIdentity,
  determineBumpTypeFromCommits: mockDetermineBumpTypeFromCommits,
  getLatestGitTag: mockGetLatestGitTag,
  getLatestPrereleaseTagForVersion: mockGetLatestPrereleaseTagForVersion,
  git: { userName: mockGitUserName, userEmail: mockGitUserEmail },
  Logger: class {
    info = mockLoggerInfo;
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
  parseVersion: mockParseVersion,
  readProjectVersion: mockReadProjectVersion,
  tagExists: mockTagExists,
}));

import { compareVersions, determineBumpType, generateChangelog, getInputs, run, updateVersionFile } from "./logic.js";

// ── getInputs ──────────────────────────────────────────────────────

describe("getInputs", () => {
  it("returns all inputs with defaults", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "ghs_token123";
      return "";
    });

    const inputs = getInputs();

    expect(inputs.bumpType).toBe("auto");
    expect(inputs.createTag).toBe(true);
    expect(inputs.createRelease).toBe(true);
    expect(inputs.releaseDraft).toBe(false);
    expect(inputs.releasePrerelease).toBe(false);
    expect(inputs.prereleaseIdentifier).toBe("alpha");
    expect(inputs.generateChangelog).toBe(true);
    expect(inputs.updateVersionFile).toBe(true);
    expect(inputs.pushChanges).toBe(true);
    expect(inputs.githubToken).toBe("ghs_token123");
    expect(inputs.dryRun).toBe(false);
  });

  it("throws when github_token is missing and dry_run is false", () => {
    mockGetInput.mockReturnValue("");

    expect(() => getInputs()).toThrow("github_token is required (unless dry_run is true)");
  });

  it("does not throw when github_token is missing but dry_run is true", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "dry_run") return "true";
      return "";
    });

    const inputs = getInputs();

    expect(inputs.dryRun).toBe(true);
    expect(inputs.githubToken).toBe("");
  });

  it("parses create_tag=false", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "create_tag") return "false";
      return "";
    });

    expect(getInputs().createTag).toBe(false);
  });

  it("parses create_release=false", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "create_release") return "false";
      return "";
    });

    expect(getInputs().createRelease).toBe(false);
  });

  it("parses release_draft=true", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "release_draft") return "true";
      return "";
    });

    expect(getInputs().releaseDraft).toBe(true);
  });

  it("parses release_prerelease=true", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "release_prerelease") return "true";
      return "";
    });

    expect(getInputs().releasePrerelease).toBe(true);
  });

  it("parses explicit bump_type", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "bump_type") return "minor";
      return "";
    });

    expect(getInputs().bumpType).toBe("minor");
  });

  it("parses custom prerelease_identifier", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "prerelease_identifier") return "beta";
      return "";
    });

    expect(getInputs().prereleaseIdentifier).toBe("beta");
  });

  it("parses generate_changelog=false", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "generate_changelog") return "false";
      return "";
    });

    expect(getInputs().generateChangelog).toBe(false);
  });

  it("parses update_version_file=false", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "update_version_file") return "false";
      return "";
    });

    expect(getInputs().updateVersionFile).toBe(false);
  });

  it("parses push_changes=false", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "github_token") return "token";
      if (name === "push_changes") return "false";
      return "";
    });

    expect(getInputs().pushChanges).toBe(false);
  });
});

// ── compareVersions ────────────────────────────────────────────────

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("returns positive when v1 major > v2 major", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0);
  });

  it("returns negative when v1 major < v2 major", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns positive when v1 minor > v2 minor", () => {
    expect(compareVersions("1.2.0", "1.1.0")).toBeGreaterThan(0);
  });

  it("returns negative when v1 minor < v2 minor", () => {
    expect(compareVersions("1.1.0", "1.2.0")).toBeLessThan(0);
  });

  it("returns positive when v1 patch > v2 patch", () => {
    expect(compareVersions("1.0.2", "1.0.1")).toBeGreaterThan(0);
  });

  it("returns negative when v1 patch < v2 patch", () => {
    expect(compareVersions("1.0.1", "1.0.2")).toBeLessThan(0);
  });

  it("returns negative when v1 is prerelease and v2 is stable", () => {
    expect(compareVersions("1.0.0-alpha.1", "1.0.0")).toBe(-1);
  });

  it("returns positive when v1 is stable and v2 is prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-alpha.1")).toBe(1);
  });

  it("returns 0 when both are prerelease with same base", () => {
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-beta.2")).toBe(0);
  });
});

// ── determineBumpType ──────────────────────────────────────────────

describe("determineBumpType", () => {
  it("uses latestTag..HEAD when latestTag is provided", async () => {
    mockExecExec.mockImplementation(
      async (
        _cmd: string,
        args?: string[],
        opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
      ) => {
        if (args?.[0] === "log") {
          opts?.listeners?.stdout?.(Buffer.from("abc1234 feat: something\ndef5678 fix: something\n"));
        }
        return 0;
      },
    );

    await determineBumpType("v1.0.0");

    expect(mockExecExec).toHaveBeenCalledWith(
      "git",
      ["log", "v1.0.0..HEAD", "--oneline"],
      expect.objectContaining({ silent: true }),
    );
    expect(mockDetermineBumpTypeFromCommits).toHaveBeenCalledWith([
      "abc1234 feat: something",
      "def5678 fix: something",
    ]);
  });

  it("uses log --oneline -20 when latestTag is null", async () => {
    mockExecExec.mockImplementation(
      async (
        _cmd: string,
        args?: string[],
        opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
      ) => {
        if (args?.[0] === "log") {
          opts?.listeners?.stdout?.(Buffer.from("abc1234 fix: bug\n"));
        }
        return 0;
      },
    );

    await determineBumpType(null);

    expect(mockExecExec).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline", "-20"],
      expect.objectContaining({ silent: true }),
    );
  });

  it("filters out empty commit lines", async () => {
    mockExecExec.mockImplementation(
      async (
        _cmd: string,
        args?: string[],
        opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
      ) => {
        if (args?.[0] === "log") {
          opts?.listeners?.stdout?.(Buffer.from("\nabc fix: x\n\n"));
        }
        return 0;
      },
    );

    await determineBumpType(null);

    expect(mockDetermineBumpTypeFromCommits).toHaveBeenCalledWith(["abc fix: x"]);
  });

  it("returns the result from determineBumpTypeFromCommits", async () => {
    mockExecExec.mockImplementation(
      async (
        _cmd: string,
        _args?: string[],
        opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
      ) => {
        opts?.listeners?.stdout?.(Buffer.from("abc feat: new feature\n"));
        return 0;
      },
    );
    mockDetermineBumpTypeFromCommits.mockReturnValue("minor");

    const result = await determineBumpType(null);

    expect(result).toBe("minor");
  });
});

// ── generateChangelog ──────────────────────────────────────────────

describe("generateChangelog", () => {
  it("generates changelog from latestTag..HEAD when tag is present", async () => {
    mockExecExec.mockImplementation(
      async (
        _cmd: string,
        args?: string[],
        opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
      ) => {
        if (args?.[0] === "log") {
          opts?.listeners?.stdout?.(Buffer.from("- feat: add thing (abc123)\n- fix: broken (def456)\n"));
        }
        return 0;
      },
    );

    const result = await generateChangelog("v1.0.0");

    expect(mockExecExec).toHaveBeenCalledWith(
      "git",
      ["log", "v1.0.0..HEAD", "--pretty=format:- %s (%h)"],
      expect.objectContaining({ silent: true }),
    );
    expect(result).toBe("- feat: add thing (abc123)\n- fix: broken (def456)");
  });

  it("generates changelog with -20 limit when no tag", async () => {
    mockExecExec.mockImplementation(
      async (
        _cmd: string,
        args?: string[],
        opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
      ) => {
        if (args?.[0] === "log") {
          opts?.listeners?.stdout?.(Buffer.from("- initial (abc123)\n"));
        }
        return 0;
      },
    );

    const result = await generateChangelog(null);

    expect(mockExecExec).toHaveBeenCalledWith(
      "git",
      ["log", "--pretty=format:- %s (%h)", "-20"],
      expect.objectContaining({ silent: true }),
    );
    expect(result).toBe("- initial (abc123)");
  });

  it("returns 'No changes recorded.' when output is empty", async () => {
    mockExecExec.mockImplementation(async (_cmd: string, _args?: string[], _opts?: unknown) => 0);

    const result = await generateChangelog(null);

    expect(result).toBe("No changes recorded.");
  });
});

// ── updateVersionFile ──────────────────────────────────────────────

describe("updateVersionFile", () => {
  it("executes npm version with --no-git-tag-version", async () => {
    await updateVersionFile("/workspace", "1.2.3");

    expect(mockExecExec).toHaveBeenCalledWith("npm", ["version", "1.2.3", "--no-git-tag-version", "--force"], {
      cwd: "/workspace",
    });
  });
});

// ── run ────────────────────────────────────────────────────────────

describe("versioning run", () => {
  function setupInputs(overrides: Record<string, string> = {}) {
    const defaults: Record<string, string> = {
      github_token: "ghs_token",
      bump_type: "",
      working_directory: ".",
      create_tag: "",
      create_release: "",
      release_draft: "",
      release_prerelease: "",
      prerelease_identifier: "",
      generate_changelog: "",
      update_version_file: "",
      push_changes: "",
      git_user_name: "",
      git_user_email: "",
      dry_run: "",
      ...overrides,
    };

    mockGetInput.mockImplementation((name: string) => defaults[name] ?? "");
  }

  beforeEach(() => {
    setupInputs();
    // Default: stable tag exists at v1.0.0 (tag-driven, not package.json)
    mockGetLatestGitTag.mockResolvedValue("v1.0.0");
    mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);
    mockTagExists.mockResolvedValue(false);
    mockBumpVersion.mockReturnValue("1.0.1");
    mockDetermineBumpTypeFromCommits.mockReturnValue("patch");
    mockExecExec.mockImplementation(
      async (
        _cmd: string,
        _args?: string[],
        opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
      ) => {
        // Simulate commit log output for determineBumpType
        if (_args?.[0] === "log") {
          opts?.listeners?.stdout?.(Buffer.from("abc1234 fix: something\n"));
        }
        return 0;
      },
    );
  });

  describe("tag-driven version source", () => {
    it("derives base version from stable tag when tag exists", async () => {
      mockGetLatestGitTag.mockResolvedValue("v2.3.0");
      mockBumpVersion.mockReturnValue("2.3.1");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v2.3.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      // Should NOT call readProjectVersion when tag exists
      expect(mockReadProjectVersion).not.toHaveBeenCalled();
      expect(mockBumpVersion).toHaveBeenCalledWith("2.3.0", "patch");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "2.3.1");
      expect(mockSetOutput).toHaveBeenCalledWith("previous_version", "2.3.0");
    });

    it("falls back to package.json when no stable tags exist (bootstrap)", async () => {
      mockGetLatestGitTag.mockResolvedValue(null);
      mockReadProjectVersion.mockReturnValue("0.1.1");
      mockBumpVersion.mockReturnValue("0.1.2");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v0.1.2" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      // Should call readProjectVersion as bootstrap fallback
      expect(mockReadProjectVersion).toHaveBeenCalled();
      expect(mockBumpVersion).toHaveBeenCalledWith("0.1.1", "patch");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "0.1.2");
      expect(mockSetOutput).toHaveBeenCalledWith("previous_version", "0.1.1");
    });
  });

  describe("stable release (auto bump)", () => {
    it("performs version bump, creates tag, pushes, and creates release", async () => {
      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1" },
      }));
      const mockGetReleaseByTag = vi.fn(async () => {
        const err = new Error("Not Found") as Error & { status: number };
        err.status = 404;
        throw err;
      });
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: mockGetReleaseByTag,
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockConfigureGitIdentity).toHaveBeenCalled();
      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.0.1");
      expect(mockSetOutput).toHaveBeenCalledWith("previous_version", "1.0.0");
      expect(mockSetOutput).toHaveBeenCalledWith("bump_type", "patch");
      expect(mockSetOutput).toHaveBeenCalledWith("tag", "v1.0.1");
      expect(mockSetOutput).toHaveBeenCalledWith("is_prerelease", "false");
      expect(mockSetOutput).toHaveBeenCalledWith(
        "release_url",
        "https://github.com/krashidbuilt/ctrl/releases/v1.0.1",
      );
    });

    it("skips version bump when no commits found", async () => {
      mockDetermineBumpTypeFromCommits.mockReturnValue("none");

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "");
      expect(mockSetOutput).toHaveBeenCalledWith("bump_type", "none");
      expect(mockSetOutput).toHaveBeenCalledWith("skipped", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("is_prerelease", "false");
    });

    it("uses explicit bump_type instead of auto-detecting", async () => {
      setupInputs({ bump_type: "major" });
      mockBumpVersion.mockReturnValue("2.0.0");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v2.0.0" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockBumpVersion).toHaveBeenCalledWith("1.0.0", "major");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "2.0.0");
      expect(mockSetOutput).toHaveBeenCalledWith("bump_type", "major");
    });

    it("bumps from tag version directly (no compareVersions needed)", async () => {
      mockGetLatestGitTag.mockResolvedValue("v1.5.0");
      mockBumpVersion.mockReturnValue("1.5.1");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.5.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockBumpVersion).toHaveBeenCalledWith("1.5.0", "patch");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.5.1");
    });
  });

  describe("prerelease", () => {
    beforeEach(() => {
      setupInputs({ release_prerelease: "true" });
    });

    it("derives prerelease base from stable tag + bump type", async () => {
      // v1.0.0 + feat: → nextStableBase = 1.1.0 → v1.1.0-alpha.1
      mockGetLatestGitTag.mockResolvedValue("v1.0.0");
      mockDetermineBumpTypeFromCommits.mockReturnValue("minor");
      mockBumpVersion.mockReturnValue("1.1.0");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.1.0-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      // bumpVersion called with (tagVersion, bumpType) to derive nextStableBase
      expect(mockBumpVersion).toHaveBeenCalledWith("1.0.0", "minor");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.1.0-alpha.1");
      expect(mockSetOutput).toHaveBeenCalledWith("is_prerelease", "true");
    });

    it("defaults none bump to patch for prereleases", async () => {
      // v1.0.0 + chore: (none) → effectiveBump = patch → nextStableBase = 1.0.1
      mockGetLatestGitTag.mockResolvedValue("v1.0.0");
      mockDetermineBumpTypeFromCommits.mockReturnValue("none");
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      // effectiveBump should be "patch" (defaulted from "none")
      expect(mockBumpVersion).toHaveBeenCalledWith("1.0.0", "patch");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.0.1-alpha.1");
    });

    it("falls back to package.json when no stable tags for prerelease", async () => {
      mockGetLatestGitTag.mockResolvedValue(null);
      mockReadProjectVersion.mockReturnValue("0.1.1");
      mockDetermineBumpTypeFromCommits.mockReturnValue("minor");
      mockBumpVersion.mockReturnValue("0.2.0");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v0.2.0-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockReadProjectVersion).toHaveBeenCalled();
      expect(mockBumpVersion).toHaveBeenCalledWith("0.1.1", "minor");
      expect(mockSetOutput).toHaveBeenCalledWith("version", "0.2.0-alpha.1");
    });

    it("increments prerelease number from existing tag", async () => {
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue("v1.0.1-alpha.3");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.4" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.0.1-alpha.4");
    });

    it("uses custom prerelease_identifier", async () => {
      setupInputs({ release_prerelease: "true", prerelease_identifier: "beta" });
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue("v1.0.1-beta.2");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-beta.3" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.0.1-beta.3");
    });

    it("skips existing tags (race condition handling)", async () => {
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);
      let tagExistsCalls = 0;
      mockTagExists.mockImplementation(async () => {
        tagExistsCalls++;
        return tagExistsCalls <= 2; // first two tags exist, third is free
      });

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.3" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.0.1-alpha.3");
    });

    it("throws after max attempts to find available version", async () => {
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);
      mockTagExists.mockResolvedValue(true); // all tags exist

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith(
        expect.stringContaining("Could not find available version after 10 attempts"),
      );
    });

    it("falls back to prereleaseNum=1 when prerelease tag doesn't match identifier pattern", async () => {
      mockBumpVersion.mockReturnValue("1.0.1");
      // Return a tag that matches but with a different prerelease format
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue("v1.0.1-alpha.notanumber");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.0.1-alpha.1");
    });
  });

  describe("changelog generation", () => {
    it("generates changelog for stable release referencing latest stable tag", async () => {
      mockGetLatestGitTag.mockResolvedValue("v1.0.0");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      // generateChangelog calls exec with log
      expect(mockExecExec).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["log"]),
        expect.objectContaining({ silent: true }),
      );
    });

    it("skips changelog when generate_changelog=false", async () => {
      setupInputs({ generate_changelog: "false" });

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      // The release should be created with empty changelog
      expect(mockCreateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "",
        }),
      );
    });

    it("uses prerelease tag as changelog ref for prerelease when available", async () => {
      setupInputs({ release_prerelease: "true" });
      mockBumpVersion.mockReturnValue("1.0.1");
      // First call (prerelease search for nextStableBase): return null to get alpha.1
      // Second call (changelog ref): return the existing prerelease tag
      let prereleaseCallCount = 0;
      mockGetLatestPrereleaseTagForVersion.mockImplementation(async () => {
        prereleaseCallCount++;
        if (prereleaseCallCount === 1) return null; // version resolution
        return "v1.0.1-alpha.2"; // changelog ref
      });
      mockGetLatestGitTag.mockResolvedValue("v1.0.0");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      // generateChangelog should be called with prerelease tag ref
      expect(mockExecExec).toHaveBeenCalledWith(
        "git",
        ["log", "v1.0.1-alpha.2..HEAD", "--pretty=format:- %s (%h)"],
        expect.objectContaining({ silent: true }),
      );
    });

    it("falls back to stable tag as changelog ref for prerelease when no prerelease tag", async () => {
      setupInputs({ release_prerelease: "true" });
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);
      mockGetLatestGitTag.mockResolvedValue("v1.0.0");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockExecExec).toHaveBeenCalledWith(
        "git",
        ["log", "v1.0.0..HEAD", "--pretty=format:- %s (%h)"],
        expect.objectContaining({ silent: true }),
      );
    });
  });

  describe("dry run mode", () => {
    beforeEach(() => {
      setupInputs({ dry_run: "true" });
    });

    it("sets outputs but does not create tag, push, or release", async () => {
      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "1.0.1");
      expect(mockSetOutput).toHaveBeenCalledWith("tag", "v1.0.1");
      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
      // Should NOT call npm version or git push
      expect(mockExecExec).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
      expect(mockGetOctokit).not.toHaveBeenCalled();
    });

    it("logs version file update when updateVersionFile is true", async () => {
      await run();

      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
    });

    it("logs create tag when createTag is true", async () => {
      await run();

      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
    });

    it("logs create release when createRelease is true", async () => {
      await run();

      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
    });

    it("truncates changelog preview to 10 lines", async () => {
      // Simulate a long changelog
      const longChangelog = Array.from({ length: 15 }, (_, i) => `- commit ${i + 1} (abc${i})`).join("\n");
      mockExecExec.mockImplementation(
        async (
          _cmd: string,
          args?: string[],
          opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (args?.[0] === "log" && args?.some((a) => a.includes("--pretty"))) {
            opts?.listeners?.stdout?.(Buffer.from(longChangelog));
          } else if (args?.[0] === "log") {
            opts?.listeners?.stdout?.(Buffer.from("abc1234 fix: something\n"));
          }
          return 0;
        },
      );

      await run();

      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("... (truncated)"));
    });

    it("does not show truncation when changelog is 10 lines or fewer", async () => {
      const shortChangelog = Array.from({ length: 5 }, (_, i) => `- commit ${i + 1}`).join("\n");
      mockExecExec.mockImplementation(
        async (
          _cmd: string,
          args?: string[],
          opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (args?.[0] === "log" && args?.some((a) => a.includes("--pretty"))) {
            opts?.listeners?.stdout?.(Buffer.from(shortChangelog));
          } else if (args?.[0] === "log") {
            opts?.listeners?.stdout?.(Buffer.from("abc1234 fix: something\n"));
          }
          return 0;
        },
      );

      await run();

      // Check that truncation message was NOT emitted
      const truncationCalls = mockLoggerInfo.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && call[0].includes("(truncated)"),
      );
      expect(truncationCalls).toHaveLength(0);
    });
  });

  describe("tag creation", () => {
    it("updates version file, commits, tags, and pushes", async () => {
      setupInputs({ create_release: "false" });

      await run();

      expect(mockExecExec).toHaveBeenCalledWith(
        "npm",
        ["version", "1.0.1", "--no-git-tag-version", "--force"],
        expect.objectContaining({ cwd: expect.any(String) }),
      );
      expect(mockExecExec).toHaveBeenCalledWith(
        "git",
        ["add", "-A"],
        expect.objectContaining({ cwd: expect.any(String) }),
      );
      expect(mockExecExec).toHaveBeenCalledWith("git", ["commit", "-m", "chore(release): v1.0.1"]);
      expect(mockExecExec).toHaveBeenCalledWith("git", ["tag", "-a", "v1.0.1", "-m", "Release v1.0.1"]);
      expect(mockExecExec).toHaveBeenCalledWith("git", ["push", "--set-upstream", "origin", "HEAD"]);
      expect(mockExecExec).toHaveBeenCalledWith("git", ["push", "origin", "v1.0.1"]);
    });

    it("creates tag-only without version file update when updateVersionFile is false", async () => {
      setupInputs({ update_version_file: "false", create_release: "false" });

      await run();

      expect(mockExecExec).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
      expect(mockExecExec).toHaveBeenCalledWith("git", ["tag", "-a", "v1.0.1", "-m", "Release v1.0.1"]);
      expect(mockExecExec).toHaveBeenCalledWith("git", ["push", "origin", "v1.0.1"]);
    });

    it("skips tag creation when tag already exists", async () => {
      setupInputs({ update_version_file: "false", create_release: "false" });
      // tagExists is checked twice: once during prerelease loop (not applicable here),
      // and once before tag creation. Override for the tag creation check.
      mockTagExists.mockResolvedValue(true);

      await run();

      expect(mockExecExec).not.toHaveBeenCalledWith("git", ["tag", "-a", expect.any(String), "-m", expect.any(String)]);
      expect(mockExecExec).toHaveBeenCalledWith("git", ["push", "origin", "v1.0.1"]);
    });

    it("does not push when pushChanges is false", async () => {
      setupInputs({ push_changes: "false", create_release: "false" });

      await run();

      expect(mockExecExec).toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
      expect(mockExecExec).not.toHaveBeenCalledWith("git", ["push", "--set-upstream", "origin", "HEAD"]);
    });

    it("does not push when pushChanges is false (tag-only mode)", async () => {
      setupInputs({ push_changes: "false", update_version_file: "false", create_release: "false" });

      await run();

      expect(mockExecExec).not.toHaveBeenCalledWith("git", ["push", "origin", expect.any(String)]);
    });

    it("skips tag but still updates version file when createTag is false", async () => {
      setupInputs({ create_tag: "false", create_release: "false" });

      await run();

      expect(mockExecExec).toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
      expect(mockExecExec).not.toHaveBeenCalledWith("git", ["tag", "-a", expect.any(String), "-m", expect.any(String)]);
    });
  });

  describe("GitHub release creation", () => {
    it("creates a new release when none exists", async () => {
      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockCreateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "krashidbuilt",
          repo: "ctrl",
          tag_name: "v1.0.1",
          name: "v1.0.1",
          prerelease: false,
        }),
      );
      expect(mockSetOutput).toHaveBeenCalledWith(
        "release_url",
        "https://github.com/krashidbuilt/ctrl/releases/v1.0.1",
      );
    });

    it("updates an existing release", async () => {
      const mockUpdateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-updated" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => ({
              data: { id: 42 },
            })),
            updateRelease: mockUpdateRelease,
          },
        },
      });

      await run();

      expect(mockUpdateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: "krashidbuilt",
          repo: "ctrl",
          release_id: 42,
          name: "v1.0.1",
          prerelease: false,
        }),
      );
      expect(mockSetOutput).toHaveBeenCalledWith(
        "release_url",
        "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-updated",
      );
    });

    it("names prerelease with (Pre-release) suffix", async () => {
      setupInputs({ release_prerelease: "true" });
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockCreateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "v1.0.1-alpha.1 (Pre-release)",
          prerelease: true,
        }),
      );
    });

    it("re-throws non-404 errors from getReleaseByTag", async () => {
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Internal Server Error") as Error & { status: number };
              err.status = 500;
              throw err;
            }),
          },
        },
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("Internal Server Error");
    });

    it("does not create release when createRelease is false", async () => {
      setupInputs({ create_release: "false" });

      await run();

      expect(mockGetOctokit).not.toHaveBeenCalled();
    });

    it("uses releaseDraft input when creating release", async () => {
      setupInputs({ release_draft: "true" });

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/releases/draft" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockCreateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: true,
        }),
      );
    });
  });

  describe("promotion (promote_from)", () => {
    function setupPromotionInputs(overrides: Record<string, string> = {}) {
      setupInputs({ promote_from: "alpha", ...overrides });
      mockReadProjectVersion.mockReturnValue("0.3.0-alpha.2");
    }

    it("replaces promoteFrom identifier with prereleaseIdentifier", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta" });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "0.3.0-beta.2");
      expect(mockSetOutput).toHaveBeenCalledWith("previous_version", "0.3.0-alpha.2");
      expect(mockSetOutput).toHaveBeenCalledWith("bump_type", "promote");
      expect(mockSetOutput).toHaveBeenCalledWith("tag", "v0.3.0-beta.2");
      expect(mockSetOutput).toHaveBeenCalledWith("is_prerelease", "true");
    });

    it("strips prerelease suffix when prereleaseIdentifier is empty (promote to stable)", async () => {
      setupPromotionInputs({ prerelease_identifier: "", promote_from: "beta" });
      mockReadProjectVersion.mockReturnValue("0.3.0-beta.2");

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "0.3.0");
      expect(mockSetOutput).toHaveBeenCalledWith("previous_version", "0.3.0-beta.2");
      expect(mockSetOutput).toHaveBeenCalledWith("tag", "v0.3.0");
      expect(mockSetOutput).toHaveBeenCalledWith("is_prerelease", "false");
    });

    it("skips conventional-commits bump (does not call bumpVersion)", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta" });

      await run();

      expect(mockBumpVersion).not.toHaveBeenCalled();
    });

    it("creates git tag for promoted version", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta" });
      mockTagExists.mockResolvedValue(false);

      await run();

      expect(mockExecExec).toHaveBeenCalledWith("git", ["tag", "-a", "v0.3.0-beta.2", "-m", "Release v0.3.0-beta.2"]);
    });

    it("skips tag creation when createTag is false", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta", create_tag: "false" });

      await run();

      const tagCalls = (mockExecExec.mock.calls as string[][]).filter(
        (call) => call[0] === "git" && Array.isArray(call[1]) && (call[1] as string[])[0] === "tag",
      );
      expect(tagCalls).toHaveLength(0);
    });

    it("creates GitHub release for promoted version", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta" });

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v0.3.0-beta.2" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockCreateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          tag_name: "v0.3.0-beta.2",
          name: "v0.3.0-beta.2 (Pre-release)",
          prerelease: true,
        }),
      );
      expect(mockSetOutput).toHaveBeenCalledWith(
        "release_url",
        "https://github.com/krashidbuilt/ctrl/releases/v0.3.0-beta.2",
      );
    });

    it("updates an existing release for promoted version", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta" });

      const mockUpdateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v0.3.0-beta.2-updated" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => ({ data: { id: 99 } })),
            updateRelease: mockUpdateRelease,
          },
        },
      });

      await run();

      expect(mockUpdateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          release_id: 99,
          name: "v0.3.0-beta.2 (Pre-release)",
          prerelease: true,
        }),
      );
    });

    it("names stable promoted release without (Pre-release) suffix", async () => {
      setupPromotionInputs({ prerelease_identifier: "", promote_from: "beta" });
      mockReadProjectVersion.mockReturnValue("0.3.0-beta.2");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v0.3.0" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockCreateRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "v0.3.0",
          prerelease: false,
        }),
      );
    });

    it("dry run logs promotion plan and returns early without side effects", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta", dry_run: "true" });
      // no github_token in dry_run mode is fine
      setupInputs({ promote_from: "alpha", prerelease_identifier: "beta", dry_run: "true", github_token: "" });
      mockReadProjectVersion.mockReturnValue("0.3.0-alpha.2");

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("version", "0.3.0-beta.2");
      expect(mockSetOutput).toHaveBeenCalledWith("bump_type", "promote");
      expect(mockGetOctokit).not.toHaveBeenCalled();
      // No git exec calls for tagging/pushing
      const execCalls = (mockExecExec.mock.calls as string[][]).filter(
        (call) =>
          call[0] === "git" && Array.isArray(call[1]) && ["tag", "push", "commit"].includes((call[1] as string[])[0]),
      );
      expect(execCalls).toHaveLength(0);
    });

    it("re-throws non-404 errors from getReleaseByTag during promotion", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta" });

      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Server Error") as Error & { status: number };
              err.status = 500;
              throw err;
            }),
          },
        },
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("Server Error");
    });

    it("updates version file and commits during promotion when updateVersionFile is true", async () => {
      setupPromotionInputs({ prerelease_identifier: "beta", update_version_file: "true" });
      // suppress release creation
      setupInputs({
        promote_from: "alpha",
        prerelease_identifier: "beta",
        update_version_file: "true",
        create_release: "false",
        github_token: "ghs_token",
      });
      mockReadProjectVersion.mockReturnValue("0.3.0-alpha.2");

      await run();

      expect(mockExecExec).toHaveBeenCalledWith(
        "npm",
        ["version", "0.3.0-beta.2", "--no-git-tag-version", "--force"],
        expect.objectContaining({ cwd: expect.any(String) }),
      );
      expect(mockExecExec).toHaveBeenCalledWith("git", ["commit", "-m", "chore(release): v0.3.0-beta.2"]);
    });
  });

  describe("error handling", () => {
    it("calls setFailed with error message for Error instances", async () => {
      mockGetLatestGitTag.mockRejectedValue(new Error("git error"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("git error");
    });

    it("calls setFailed with generic message for non-Error instances", async () => {
      mockGetLatestGitTag.mockRejectedValue("string error");

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
    });
  });

  describe("isPrerelease flag", () => {
    it("is true when releasePrerelease input is true", async () => {
      setupInputs({ release_prerelease: "true" });
      mockBumpVersion.mockReturnValue("1.0.1");
      mockGetLatestPrereleaseTagForVersion.mockResolvedValue(null);

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-alpha.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("is_prerelease", "true");
    });

    it("is true when version contains a hyphen (e.g. prerelease in version string)", async () => {
      // This covers the `newVersion.includes("-")` branch
      mockBumpVersion.mockReturnValue("1.0.1-rc.1");

      const mockCreateRelease = vi.fn(async () => ({
        data: { html_url: "https://github.com/krashidbuilt/ctrl/releases/v1.0.1-rc.1" },
      }));
      mockGetOctokit.mockReturnValue({
        rest: {
          repos: {
            getReleaseByTag: vi.fn(async () => {
              const err = new Error("Not Found") as Error & { status: number };
              err.status = 404;
              throw err;
            }),
            createRelease: mockCreateRelease,
          },
        },
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("is_prerelease", "true");
    });
  });
});
