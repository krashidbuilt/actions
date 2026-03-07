import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
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

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
}));

const { mockConfigureGitIdentity, mockExecGit } = vi.hoisted(() => ({
  mockConfigureGitIdentity: vi.fn(async () => {}),
  mockExecGit: vi.fn(async () => "") as Mock,
}));

vi.mock("../../../core/index.js", () => ({
  configureGitIdentity: mockConfigureGitIdentity,
  execGit: mockExecGit,
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { hasChanges, run } from "./logic.js";

describe("hasChanges", () => {
  it("returns true when there are staged changes (execGit rejects)", async () => {
    mockExec.mockResolvedValue(0);
    mockExecGit.mockRejectedValue(new Error("diff exit code 1"));

    const result = await hasChanges(["dist/"]);

    expect(mockExec).toHaveBeenCalledWith("git", ["add", "-f", "dist/"], { silent: true });
    expect(mockExecGit).toHaveBeenCalledWith(["diff", "--cached", "--quiet"]);
    expect(result).toBe(true);
  });

  it("returns false when there are no staged changes (execGit resolves)", async () => {
    mockExec.mockResolvedValue(0);
    mockExecGit.mockResolvedValue("");

    const result = await hasChanges(["dist/"]);

    expect(result).toBe(false);
  });

  it("passes multiple paths to git add", async () => {
    mockExec.mockResolvedValue(0);
    mockExecGit.mockResolvedValue("");

    await hasChanges(["dist/", "lib/", "out/"]);

    expect(mockExec).toHaveBeenCalledWith("git", ["add", "-f", "dist/", "lib/", "out/"], { silent: true });
  });
});

describe("commit-artifacts run", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.GITHUB_HEAD_REF;
    delete process.env.GITHUB_REF_NAME;

    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "paths":
          return "dist/";
        case "message":
          return "chore: bundle";
        case "git_user_name":
          return "bot";
        case "git_user_email":
          return "bot@example.com";
        case "dry_run":
          return "false";
        default:
          return "";
      }
    });

    // Default: there are changes
    mockExecGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff" && args.includes("--quiet")) {
        throw new Error("changes");
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "abc123";
      }
      return "";
    });
    mockExec.mockResolvedValue(0);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("configures git identity", async () => {
    await run();

    expect(mockConfigureGitIdentity).toHaveBeenCalledWith("bot", "bot@example.com");
  });

  it("commits and pushes successfully on first try", async () => {
    await run();

    // commit
    expect(mockExec).toHaveBeenCalledWith("git", ["commit", "-m", "chore: bundle"]);
    // push with ignoreReturnCode
    expect(mockExec).toHaveBeenCalledWith("git", ["push", "origin", "develop"], {
      ignoreReturnCode: true,
    });
    expect(mockSetOutput).toHaveBeenCalledWith("committed", "true");
    expect(mockSetOutput).toHaveBeenCalledWith("sha", "abc123");
  });

  it("uses GITHUB_HEAD_REF for branch when available", async () => {
    process.env.GITHUB_HEAD_REF = "feature-branch";

    await run();

    expect(mockExec).toHaveBeenCalledWith("git", ["push", "origin", "feature-branch"], {
      ignoreReturnCode: true,
    });
  });

  it("uses GITHUB_REF_NAME for branch when GITHUB_HEAD_REF is not set", async () => {
    process.env.GITHUB_REF_NAME = "release-branch";

    await run();

    expect(mockExec).toHaveBeenCalledWith("git", ["push", "origin", "release-branch"], {
      ignoreReturnCode: true,
    });
  });

  it("falls back to 'develop' when no env vars are set", async () => {
    await run();

    expect(mockExec).toHaveBeenCalledWith("git", ["push", "origin", "develop"], {
      ignoreReturnCode: true,
    });
  });

  it("rebases and retries push when first push fails (non-shallow)", async () => {
    let pushCallCount = 0;
    mockExec.mockImplementation(async (_cmd: string, args?: string[], _opts?: unknown) => {
      if (args?.[0] === "push" && args?.[1] === "origin") {
        pushCallCount++;
        if (pushCallCount === 1) {
          return 1; // first push fails
        }
        return 0;
      }
      return 0;
    });
    mockExecGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff" && args.includes("--quiet")) {
        throw new Error("changes");
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return "false";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "def456";
      }
      return "";
    });

    await run();

    // Verify non-shallow fetch was used
    expect(mockExec).toHaveBeenCalledWith("git", ["fetch", "origin", "develop"], { silent: true });
    expect(mockExec).toHaveBeenCalledWith("git", ["rebase", "origin/develop"]);
    expect(mockSetOutput).toHaveBeenCalledWith("committed", "true");
    expect(mockSetOutput).toHaveBeenCalledWith("sha", "def456");
  });

  it("uses --deepen=50 when first push fails in a shallow repo", async () => {
    let pushCallCount = 0;
    mockExec.mockImplementation(async (_cmd: string, args?: string[], _opts?: unknown) => {
      if (args?.[0] === "push" && args?.[1] === "origin") {
        pushCallCount++;
        if (pushCallCount === 1) {
          return 1;
        }
        return 0;
      }
      return 0;
    });
    mockExecGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff" && args.includes("--quiet")) {
        throw new Error("changes");
      }
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
        return "true";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return "ghi789";
      }
      return "";
    });

    await run();

    expect(mockExec).toHaveBeenCalledWith("git", ["fetch", "--deepen=50", "origin", "develop"], {
      ignoreReturnCode: true,
    });
    expect(mockExec).toHaveBeenCalledWith("git", ["rebase", "origin/develop"]);
  });

  it("outputs committed=false and empty sha when no changes", async () => {
    mockExecGit.mockImplementation(async (args: string[]) => {
      if (args[0] === "diff" && args.includes("--quiet")) {
        return ""; // no changes
      }
      return "";
    });

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith("committed", "false");
    expect(mockSetOutput).toHaveBeenCalledWith("sha", "");
    expect(mockExec).not.toHaveBeenCalledWith("git", ["commit", "-m", expect.any(String)]);
  });

  it("uses default commit message when message input is empty", async () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "paths":
          return "dist/";
        case "message":
          return "";
        case "dry_run":
          return "false";
        default:
          return "";
      }
    });

    await run();

    expect(mockExec).toHaveBeenCalledWith("git", ["commit", "-m", "chore: bundle artifacts"]);
  });

  it("uses default git user name and email when not provided", async () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "paths":
          return "dist/";
        case "git_user_name":
          return "";
        case "git_user_email":
          return "";
        case "dry_run":
          return "false";
        default:
          return "";
      }
    });

    await run();

    expect(mockConfigureGitIdentity).toHaveBeenCalledWith(
      "github-actions[bot]",
      "github-actions[bot]@users.noreply.github.com",
    );
  });

  it("splits paths by whitespace and filters empty", async () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "paths":
          return "dist/  lib/\tout/";
        case "dry_run":
          return "false";
        default:
          return "";
      }
    });

    await run();

    expect(mockExec).toHaveBeenCalledWith("git", ["add", "-f", "dist/", "lib/", "out/"], { silent: true });
  });

  describe("dry run mode", () => {
    beforeEach(() => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "paths":
            return "dist/";
          case "message":
            return "chore: bundle";
          case "dry_run":
            return "true";
          default:
            return "";
        }
      });
    });

    it("shows changed files and resets without committing", async () => {
      // Simulate the stdout listener for diff --name-only
      mockExec.mockImplementation(
        async (
          _cmd: string,
          args?: string[],
          opts?: { listeners?: { stdout?: (data: Buffer) => void }; silent?: boolean },
        ) => {
          if (args?.[0] === "diff" && args?.[1] === "--cached" && args?.[2] === "--name-only") {
            opts?.listeners?.stdout?.(Buffer.from("dist/index.js\ndist/bundle.js\n"));
          }
          return 0;
        },
      );

      await run();

      // Should reset HEAD after dry run
      expect(mockExec).toHaveBeenCalledWith("git", ["reset", "HEAD"], { silent: true });
      expect(mockSetOutput).toHaveBeenCalledWith("committed", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("sha", "");
      // Should NOT commit
      expect(mockExec).not.toHaveBeenCalledWith("git", ["commit", "-m", expect.any(String)]);
    });

    it("returns early with committed=false when no changes in dry run", async () => {
      mockExecGit.mockImplementation(async (args: string[]) => {
        if (args[0] === "diff" && args.includes("--quiet")) {
          return ""; // no changes
        }
        return "";
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("committed", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("sha", "");
    });
  });

  describe("error handling", () => {
    it("calls setFailed with error message for Error instances", async () => {
      mockConfigureGitIdentity.mockRejectedValue(new Error("git config failed"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("git config failed");
    });

    it("calls setFailed with generic message for non-Error instances", async () => {
      mockConfigureGitIdentity.mockRejectedValue("string error");

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
    });
  });
});
