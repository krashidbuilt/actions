import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockGetInput, mockGetBooleanInput, mockSetOutput, mockSetFailed, mockInfo, mockWarning } = vi.hoisted(() => ({
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockGetBooleanInput: vi.fn((_name: string) => false),
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockInfo: vi.fn(),
  mockWarning: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  getBooleanInput: mockGetBooleanInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
  debug: vi.fn(),
  warning: mockWarning,
  error: vi.fn(),
  isDebug: vi.fn(() => false),
}));

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
}));

const { mockConfigureGitIdentity, mockGitUserName, mockGitUserEmail } = vi.hoisted(() => ({
  mockConfigureGitIdentity: vi.fn(async () => {}),
  mockGitUserName: vi.fn(() => "github-actions[bot]"),
  mockGitUserEmail: vi.fn(() => "github-actions[bot]@users.noreply.github.com"),
}));

vi.mock("../../../core/index.js", () => ({
  configureGitIdentity: mockConfigureGitIdentity,
  git: {
    userName: mockGitUserName,
    userEmail: mockGitUserEmail,
  },
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { getTargetBranches, mergeBranch, run } from "./logic.js";

describe("getTargetBranches", () => {
  it("parses comma-separated target_branches input", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "target_branches") return "staging, production, develop";
      return "";
    });

    expect(getTargetBranches()).toEqual(["staging", "production", "develop"]);
  });

  it("filters empty strings from target_branches", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "target_branches") return "staging,,production, ,";
      return "";
    });

    expect(getTargetBranches()).toEqual(["staging", "production"]);
  });

  it("falls back to target_branch when target_branches is empty", () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === "target_branches") return "";
      if (name === "target_branch") return "  production  ";
      return "";
    });

    expect(getTargetBranches()).toEqual(["production"]);
  });

  it("throws when neither target_branch nor target_branches is provided", () => {
    mockGetInput.mockReturnValue("");

    expect(() => getTargetBranches()).toThrow("Either target_branch or target_branches must be provided");
  });
});

describe("mergeBranch", () => {
  it("fetches, checks out, resets, merges, and pushes", async () => {
    const calls: string[][] = [];
    mockExec.mockImplementation(async (_cmd: string, args?: string[]) => {
      calls.push(args ?? []);
      return 0;
    });

    await mergeBranch("develop", "staging", "chore: merge develop into staging");

    expect(calls).toEqual([
      ["fetch", "origin", "staging"],
      ["checkout", "staging"],
      ["reset", "--hard", "origin/staging"],
      ["merge", "develop", "--no-edit", "-m", "chore: merge develop into staging"],
      ["push", "origin", "staging"],
    ]);
  });
});

describe("merge-branch run", () => {
  beforeEach(() => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "source_branch":
          return "develop";
        case "target_branches":
          return "staging";
        case "target_branch":
          return "";
        case "message":
          return "";
        default:
          return "";
      }
    });
    mockGetBooleanInput.mockImplementation((name: string) => {
      if (name === "dry_run") return false;
      return false;
    });
    mockExec.mockResolvedValue(0);
  });

  it("configures git identity", async () => {
    await run();

    expect(mockConfigureGitIdentity).toHaveBeenCalledWith(
      "github-actions[bot]",
      "github-actions[bot]@users.noreply.github.com",
    );
  });

  it("merges source into target and sets outputs on success", async () => {
    await run();

    expect(mockSetOutput).toHaveBeenCalledWith("merged", "true");
    expect(mockSetOutput).toHaveBeenCalledWith("merged_branches", "staging");
    expect(mockSetOutput).toHaveBeenCalledWith("failed_branches", "");
  });

  it("uses default merge message when message input is empty", async () => {
    await run();

    expect(mockExec).toHaveBeenCalledWith("git", [
      "merge",
      "develop",
      "--no-edit",
      "-m",
      "chore: merge develop into staging",
    ]);
  });

  it("substitutes {target} in message template", async () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "source_branch":
          return "develop";
        case "target_branches":
          return "staging";
        case "message":
          return "chore: deploy to {target}";
        default:
          return "";
      }
    });

    await run();

    expect(mockExec).toHaveBeenCalledWith("git", ["merge", "develop", "--no-edit", "-m", "chore: deploy to staging"]);
  });

  it("merges into multiple target branches", async () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "source_branch":
          return "develop";
        case "target_branches":
          return "staging,production";
        case "message":
          return "";
        default:
          return "";
      }
    });

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith("merged", "true");
    expect(mockSetOutput).toHaveBeenCalledWith("merged_branches", "staging,production");
    expect(mockSetOutput).toHaveBeenCalledWith("failed_branches", "");
  });

  describe("dry run mode", () => {
    beforeEach(() => {
      mockGetBooleanInput.mockImplementation((name: string) => {
        if (name === "dry_run") return true;
        return false;
      });
    });

    it("logs dry run messages and sets empty outputs", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "source_branch":
            return "develop";
          case "target_branches":
            return "staging,production";
          case "message":
            return "";
          default:
            return "";
        }
      });

      await run();

      expect(mockInfo).toHaveBeenCalledWith("[DRY RUN] Would merge develop into staging");
      expect(mockInfo).toHaveBeenCalledWith("[DRY RUN] Would merge develop into production");
      expect(mockSetOutput).toHaveBeenCalledWith("merged", "false");
      expect(mockSetOutput).toHaveBeenCalledWith("merged_branches", "");
      expect(mockSetOutput).toHaveBeenCalledWith("failed_branches", "");
      // Should not have called exec for merge operations
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  describe("partial failure", () => {
    it("warns when some merges fail but at least one succeeds", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "source_branch":
            return "develop";
          case "target_branches":
            return "staging,production";
          case "message":
            return "";
          default:
            return "";
        }
      });

      let mergeCount = 0;
      mockExec.mockImplementation(async (_cmd: string, args?: string[]) => {
        if (args?.[0] === "merge") {
          mergeCount++;
          if (mergeCount === 2) {
            throw new Error("merge conflict");
          }
        }
        return 0;
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("merged", "true");
      expect(mockSetOutput).toHaveBeenCalledWith("merged_branches", "staging");
      expect(mockSetOutput).toHaveBeenCalledWith("failed_branches", "production");
      expect(mockWarning).toHaveBeenCalledWith("Failed to merge develop into production: merge conflict");
      expect(mockWarning).toHaveBeenCalledWith("Some merges failed: production");
    });
  });

  describe("total failure", () => {
    it("calls setFailed when all merges fail", async () => {
      mockExec.mockImplementation(async (_cmd: string, args?: string[]) => {
        if (args?.[0] === "merge") {
          throw new Error("merge conflict");
        }
        return 0;
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("merged", "false");
      expect(mockSetFailed).toHaveBeenCalledWith("All merges failed: staging");
    });
  });

  describe("error handling", () => {
    it("calls setFailed with error message for Error instances", async () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === "source_branch") return "develop";
        if (name === "target_branches") return "";
        if (name === "target_branch") return "";
        return "";
      });

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("Either target_branch or target_branches must be provided");
    });

    it("calls setFailed with generic message for non-Error instances", async () => {
      mockConfigureGitIdentity.mockRejectedValue(42);

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
    });
  });
});
