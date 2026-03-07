import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv, getEnvOrDefault, getRequiredEnv, github, hasEnv, setEnv } from "./env.js";

describe("getEnv", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the environment variable value", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    expect(getEnv("GITHUB_TOKEN")).toBe("ghp_test");
  });

  it("returns undefined for unset variables", () => {
    expect(getEnv("GITHUB_TOKEN")).toBeUndefined();
  });
});

describe("getEnvOrDefault", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the environment variable value when set", () => {
    vi.stubEnv("AWS_REGION", "eu-west-1");
    expect(getEnvOrDefault("AWS_REGION", "us-east-1")).toBe("eu-west-1");
  });

  it("returns the default when variable is not set", () => {
    expect(getEnvOrDefault("AWS_REGION", "us-east-1")).toBe("us-east-1");
  });
});

describe("getRequiredEnv", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the value when set", () => {
    vi.stubEnv("GITHUB_SHA", "abc123");
    expect(getRequiredEnv("GITHUB_SHA")).toBe("abc123");
  });

  it("throws when not set", () => {
    expect(() => getRequiredEnv("UNSET_TEST_VAR")).toThrow("Required environment variable UNSET_TEST_VAR is not set");
  });
});

describe("hasEnv", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when set with a value", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    expect(hasEnv("GITHUB_TOKEN")).toBe(true);
  });

  it("returns false when not set", () => {
    expect(hasEnv("GITHUB_TOKEN")).toBe(false);
  });

  it("returns false when set to empty string", () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(hasEnv("GITHUB_TOKEN")).toBe(false);
  });
});

describe("setEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sets the environment variable", () => {
    setEnv("AWS_REGION", "us-west-2");
    expect(process.env.AWS_REGION).toBe("us-west-2");
  });
});

describe("github helpers", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("getToken returns GITHUB_TOKEN", () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    expect(github.getToken()).toBe("ghp_test");
  });

  it("getRef returns GITHUB_REF", () => {
    vi.stubEnv("GITHUB_REF", "refs/heads/main");
    expect(github.getRef()).toBe("refs/heads/main");
  });

  it("getSha returns GITHUB_SHA", () => {
    vi.stubEnv("GITHUB_SHA", "abc123");
    expect(github.getSha()).toBe("abc123");
  });

  it("getRepository returns GITHUB_REPOSITORY", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "krashidbuilt/actions");
    expect(github.getRepository()).toBe("krashidbuilt/actions");
  });

  it("getRunnerOs returns RUNNER_OS or defaults to Linux", () => {
    expect(github.getRunnerOs()).toBe("Linux");

    vi.stubEnv("RUNNER_OS", "macOS");
    expect(github.getRunnerOs()).toBe("macOS");
  });

  describe("getRefForEnvironment", () => {
    it("returns GITHUB_REF for branch refs", () => {
      vi.stubEnv("GITHUB_REF", "refs/heads/develop");
      expect(github.getRefForEnvironment()).toBe("refs/heads/develop");
    });

    it("returns GITHUB_HEAD_REF for pull request refs", () => {
      vi.stubEnv("GITHUB_REF", "refs/pull/123/merge");
      vi.stubEnv("GITHUB_HEAD_REF", "feature-branch");
      expect(github.getRefForEnvironment()).toBe("refs/heads/feature-branch");
    });

    it("returns undefined for pull request with no head ref", () => {
      vi.stubEnv("GITHUB_REF", "refs/pull/123/merge");
      vi.stubEnv("GITHUB_HEAD_REF", "");
      expect(github.getRefForEnvironment()).toBeUndefined();
    });
  });
});
