import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const { mockGetInput, mockGetBooleanInput, mockSetOutput, mockSetFailed, mockInfo } = vi.hoisted(() => ({
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockGetBooleanInput: vi.fn((_name: string) => false),
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  getBooleanInput: mockGetBooleanInput,
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
  info: mockInfo,
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

vi.mock("../../../core/index.js", () => ({
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { getMajorVersion, isBetaVersion, run, updateTag } from "./logic.js";

describe("getMajorVersion", () => {
  it("extracts major version from semver string", () => {
    expect(getMajorVersion("1.2.3")).toBe("v1");
  });

  it("strips leading 'v' prefix before extracting", () => {
    expect(getMajorVersion("v2.5.0")).toBe("v2");
  });

  it("handles major version 0", () => {
    expect(getMajorVersion("0.1.0")).toBe("v0");
  });

  it("handles large major version", () => {
    expect(getMajorVersion("v123.0.0")).toBe("v123");
  });
});

describe("isBetaVersion", () => {
  it("returns true for -beta prerelease", () => {
    expect(isBetaVersion("1.0.0-beta.1")).toBe(true);
  });

  it("returns true for -alpha prerelease", () => {
    expect(isBetaVersion("1.0.0-alpha.3")).toBe(true);
  });

  it("returns true for -rc prerelease", () => {
    expect(isBetaVersion("2.0.0-rc.1")).toBe(true);
  });

  it("returns false for stable versions", () => {
    expect(isBetaVersion("1.0.0")).toBe(false);
  });

  it("returns false for versions with v prefix", () => {
    expect(isBetaVersion("v3.0.0")).toBe(false);
  });
});

describe("updateTag", () => {
  it("deletes old tag, creates new annotated tag, and force pushes", async () => {
    const calls: string[][] = [];
    mockExec.mockImplementation(async (_cmd: string, args?: string[]) => {
      calls.push(args ?? []);
      return 0;
    });

    await updateTag("v1", "Update v1 to v1.2.3");

    expect(calls).toEqual([
      ["tag", "-d", "v1"],
      ["tag", "-fa", "v1", "-m", "Update v1 to v1.2.3"],
      ["push", "origin", "v1", "--force"],
    ]);
  });

  it("appends targetRef when provided", async () => {
    const calls: string[][] = [];
    mockExec.mockImplementation(async (_cmd: string, args?: string[]) => {
      calls.push(args ?? []);
      return 0;
    });

    await updateTag("v2", "Update v2 to v2.0.0", "v2.0.0");

    expect(calls[1]).toEqual(["tag", "-fa", "v2", "-m", "Update v2 to v2.0.0", "v2.0.0"]);
  });

  it("does not append targetRef when not provided", async () => {
    const calls: string[][] = [];
    mockExec.mockImplementation(async (_cmd: string, args?: string[]) => {
      calls.push(args ?? []);
      return 0;
    });

    await updateTag("v1", "msg");

    expect(calls[1]).toEqual(["tag", "-fa", "v1", "-m", "msg"]);
  });
});

describe("update-version-tags run", () => {
  beforeEach(() => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case "version":
          return "v1.2.3";
        case "tag_type":
          return "";
        default:
          return "";
      }
    });
    mockGetBooleanInput.mockReturnValue(false);
    mockExec.mockResolvedValue(0);
  });

  describe("auto tag type (default)", () => {
    it("updates major tag for stable versions", async () => {
      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "v1");
      expect(mockSetOutput).toHaveBeenCalledWith("major_tag", "v1");
      expect(mockSetOutput).toHaveBeenCalledWith("is_beta", "false");
    });

    it("updates beta tag for prerelease versions", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "v1.2.3-beta.1";
          case "tag_type":
            return "";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "beta");
      expect(mockSetOutput).toHaveBeenCalledWith("major_tag", "");
      expect(mockSetOutput).toHaveBeenCalledWith("is_beta", "true");
    });

    it("updates beta tag for alpha versions", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "2.0.0-alpha.5";
          case "tag_type":
            return "";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "beta");
      expect(mockSetOutput).toHaveBeenCalledWith("is_beta", "true");
    });
  });

  describe("explicit tag_type=major", () => {
    it("updates only major tag even for prerelease version", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "v1.2.3-beta.1";
          case "tag_type":
            return "major";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "v1");
      expect(mockSetOutput).toHaveBeenCalledWith("major_tag", "v1");
    });
  });

  describe("explicit tag_type=beta", () => {
    it("updates only beta tag even for stable version", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "v1.2.3";
          case "tag_type":
            return "beta";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "beta");
      expect(mockSetOutput).toHaveBeenCalledWith("major_tag", "");
    });
  });

  describe("explicit tag_type=both", () => {
    it("updates both major and beta tags", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "v1.2.3";
          case "tag_type":
            return "both";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "v1,beta");
      expect(mockSetOutput).toHaveBeenCalledWith("major_tag", "v1");
    });
  });

  describe("version normalization", () => {
    it("adds v prefix if not present", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "3.0.0";
          case "tag_type":
            return "";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "v3");
      expect(mockSetOutput).toHaveBeenCalledWith("major_tag", "v3");
    });

    it("keeps v prefix if already present", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "v2.0.0";
          case "tag_type":
            return "";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "v2");
    });
  });

  describe("dry run mode", () => {
    beforeEach(() => {
      mockGetBooleanInput.mockImplementation((name: string) => {
        if (name === "dry_run") return true;
        return false;
      });
    });

    it("logs what would happen and sets empty outputs", async () => {
      await run();

      expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
      expect(mockSetOutput).toHaveBeenCalledWith("updated_tags", "");
      expect(mockSetOutput).toHaveBeenCalledWith("major_tag", "");
      expect(mockSetOutput).toHaveBeenCalledWith("is_beta", "false");
      // exec should NOT have been called for tag operations
      expect(mockExec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["tag"]));
    });

    it("reports beta=true for prerelease versions in dry run", async () => {
      mockGetInput.mockImplementation((name: string) => {
        switch (name) {
          case "version":
            return "1.0.0-beta.2";
          case "tag_type":
            return "";
          default:
            return "";
        }
      });

      await run();

      expect(mockSetOutput).toHaveBeenCalledWith("is_beta", "true");
    });
  });

  describe("error handling", () => {
    it("calls setFailed with error message for Error instances", async () => {
      mockExec.mockRejectedValue(new Error("push rejected"));

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("push rejected");
    });

    it("calls setFailed with generic message for non-Error instances", async () => {
      mockExec.mockRejectedValue("unknown failure");

      await run();

      expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
    });
  });
});
