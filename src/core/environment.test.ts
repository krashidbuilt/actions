import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(() => ""),
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

import {
  detectEnvironment,
  detectEnvironmentFromRef,
  getDomain,
  getProfile,
  isValidEnvironment,
} from "./environment.js";

describe("isValidEnvironment", () => {
  it("returns true for valid environments", () => {
    expect(isValidEnvironment("alpha")).toBe(true);
    expect(isValidEnvironment("beta")).toBe(true);
    expect(isValidEnvironment("production")).toBe(true);
  });

  it("returns false for invalid environments", () => {
    expect(isValidEnvironment("sandbox")).toBe(false);
    expect(isValidEnvironment("development")).toBe(false);
    expect(isValidEnvironment("staging")).toBe(false);
    expect(isValidEnvironment("")).toBe(false);
    expect(isValidEnvironment("local")).toBe(false);
  });
});

describe("detectEnvironmentFromRef", () => {
  it("maps develop branch to alpha", () => {
    expect(detectEnvironmentFromRef("refs/heads/develop")).toBe("alpha");
  });

  it("maps staging branch to beta", () => {
    expect(detectEnvironmentFromRef("refs/heads/staging")).toBe("beta");
  });

  it("maps production branch to production", () => {
    expect(detectEnvironmentFromRef("refs/heads/production")).toBe("production");
  });

  it("maps main branch to production", () => {
    expect(detectEnvironmentFromRef("refs/heads/main")).toBe("production");
  });

  it("returns production for tag refs", () => {
    expect(detectEnvironmentFromRef("refs/tags/v1.0.0")).toBe("production");
    expect(detectEnvironmentFromRef("refs/tags/v0.2.0-alpha.1")).toBe("production");
  });

  it("returns null for unknown branches", () => {
    expect(detectEnvironmentFromRef("refs/heads/feature/my-branch")).toBeNull();
    expect(detectEnvironmentFromRef("refs/heads/bk/my-branch")).toBeNull();
  });

  it("returns null for non-ref strings", () => {
    expect(detectEnvironmentFromRef("develop")).toBeNull();
    expect(detectEnvironmentFromRef("")).toBeNull();
  });
});

describe("detectEnvironment", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses explicit environment when provided", () => {
    expect(detectEnvironment({ explicitEnvironment: "alpha" })).toBe("alpha");
    expect(detectEnvironment({ explicitEnvironment: "beta" })).toBe("beta");
    expect(detectEnvironment({ explicitEnvironment: "production" })).toBe("production");
  });

  it("throws for invalid explicit environment", () => {
    expect(() => detectEnvironment({ explicitEnvironment: "invalid" })).toThrow('Invalid environment "invalid"');
  });

  it("detects from githubRef when no explicit environment", () => {
    expect(detectEnvironment({ githubRef: "refs/heads/develop" })).toBe("alpha");
    expect(detectEnvironment({ githubRef: "refs/heads/staging" })).toBe("beta");
  });

  it("uses default environment as fallback", () => {
    expect(
      detectEnvironment({
        githubRef: "refs/heads/feature/test",
        defaultEnvironment: "alpha",
      }),
    ).toBe("alpha");
  });

  it("throws for invalid default environment", () => {
    expect(() =>
      detectEnvironment({
        githubRef: "refs/heads/feature/test",
        defaultEnvironment: "invalid",
      }),
    ).toThrow('Invalid default environment "invalid"');
  });

  it("throws when no environment can be detected", () => {
    expect(() =>
      detectEnvironment({
        githubRef: "refs/heads/feature/test",
      }),
    ).toThrow("Unable to detect environment");
  });

  it("explicit environment takes precedence over ref", () => {
    expect(
      detectEnvironment({
        explicitEnvironment: "production",
        githubRef: "refs/heads/develop",
      }),
    ).toBe("production");
  });
});

describe("getDomain", () => {
  it("returns base domain for production", () => {
    expect(getDomain("production")).toBe("krashidbuilt.com");
  });

  it("returns alpha subdomain for alpha", () => {
    expect(getDomain("alpha")).toBe("alpha.krashidbuilt.com");
  });

  it("returns beta subdomain for beta", () => {
    expect(getDomain("beta")).toBe("beta.krashidbuilt.com");
  });
});

describe("getProfile", () => {
  it("returns production for production", () => {
    expect(getProfile("production")).toBe("production");
  });

  it("returns staging for beta", () => {
    expect(getProfile("beta")).toBe("staging");
  });

  it("returns preview for alpha", () => {
    expect(getProfile("alpha")).toBe("preview");
  });
});
