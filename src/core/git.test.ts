import { describe, expect, it, type Mock, vi } from "vitest";

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
}));

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

import { configureGitIdentity, execGit } from "./git.js";

describe("configureGitIdentity", () => {
  it("configures user.name and user.email with silent=true by default", async () => {
    await configureGitIdentity("Bot", "bot@example.com");

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenCalledWith("git", ["config", "user.name", "Bot"], { silent: true });
    expect(mockExec).toHaveBeenCalledWith("git", ["config", "user.email", "bot@example.com"], { silent: true });
  });

  it("passes silent=false when specified in options", async () => {
    await configureGitIdentity("Bot", "bot@example.com", { silent: false });

    expect(mockExec).toHaveBeenCalledWith("git", ["config", "user.name", "Bot"], { silent: false });
    expect(mockExec).toHaveBeenCalledWith("git", ["config", "user.email", "bot@example.com"], { silent: false });
  });

  it("passes silent=true when explicitly specified", async () => {
    await configureGitIdentity("Bot", "bot@example.com", { silent: true });

    expect(mockExec).toHaveBeenCalledWith("git", ["config", "user.name", "Bot"], { silent: true });
    expect(mockExec).toHaveBeenCalledWith("git", ["config", "user.email", "bot@example.com"], { silent: true });
  });

  it("propagates exec errors", async () => {
    mockExec.mockRejectedValueOnce(new Error("git config failed"));

    await expect(configureGitIdentity("Bot", "bot@example.com")).rejects.toThrow("git config failed");
  });
});

describe("execGit", () => {
  it("executes git command and returns trimmed stdout", async () => {
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        options?.listeners?.stdout?.(Buffer.from("  abc123  \n"));
        return 0;
      },
    );

    const result = await execGit(["rev-parse", "HEAD"]);
    expect(result).toBe("abc123");
  });

  it("passes args correctly to exec", async () => {
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        options?.listeners?.stdout?.(Buffer.from("output"));
        return 0;
      },
    );

    await execGit(["log", "--oneline", "-5"]);

    expect(mockExec).toHaveBeenCalledWith("git", ["log", "--oneline", "-5"], expect.objectContaining({ silent: true }));
  });

  it("defaults to silent=true", async () => {
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      },
    );

    await execGit(["status"]);

    expect(mockExec).toHaveBeenCalledWith("git", ["status"], expect.objectContaining({ silent: true }));
  });

  it("supports silent=false via options", async () => {
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        options?.listeners?.stdout?.(Buffer.from(""));
        return 0;
      },
    );

    await execGit(["status"], { silent: false });

    expect(mockExec).toHaveBeenCalledWith("git", ["status"], expect.objectContaining({ silent: false }));
  });

  it("concatenates multiple stdout chunks", async () => {
    mockExec.mockImplementation(
      async (_cmd: string, _args: string[], options?: { listeners?: { stdout?: (data: Buffer) => void } }) => {
        options?.listeners?.stdout?.(Buffer.from("chunk1"));
        options?.listeners?.stdout?.(Buffer.from(" chunk2"));
        options?.listeners?.stdout?.(Buffer.from(" chunk3"));
        return 0;
      },
    );

    const result = await execGit(["log"]);
    expect(result).toBe("chunk1 chunk2 chunk3");
  });

  it("returns empty string when no stdout", async () => {
    mockExec.mockImplementation(async () => 0);

    const result = await execGit(["status"]);
    expect(result).toBe("");
  });

  it("propagates exec errors", async () => {
    mockExec.mockRejectedValueOnce(new Error("git command failed"));

    await expect(execGit(["push"])).rejects.toThrow("git command failed");
  });
});
