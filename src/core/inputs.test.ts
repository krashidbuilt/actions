import { describe, expect, it, type Mock, vi } from "vitest";

const { mockGetInput } = vi.hoisted(() => ({
  mockGetInput: vi.fn(() => "") as Mock,
}));

const { mockGetToken } = vi.hoisted(() => ({
  mockGetToken: vi.fn(() => undefined as string | undefined),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

vi.mock("./env.js", () => ({
  github: {
    getToken: mockGetToken,
  },
}));

import { aws, build, common, git, inputs, registry, runtime } from "./inputs.js";

describe("runtime", () => {
  it("returns node_version from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "node_version" ? "20" : ""));
    expect(runtime.nodeVersion()).toBe("20");
  });

  it("returns default NODE_VERSION when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(runtime.nodeVersion()).toBe("24");
  });

  it("returns bun_version from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "bun_version" ? "1.2.0" : ""));
    expect(runtime.bunVersion()).toBe("1.2.0");
  });

  it("returns default BUN_VERSION when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(runtime.bunVersion()).toBe("1.3.5");
  });
});

describe("aws", () => {
  it("returns aws_region from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "aws_region" ? "eu-west-1" : ""));
    expect(aws.region()).toBe("eu-west-1");
  });

  it("returns default region when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(aws.region()).toBe("us-east-1");
  });
});

describe("registry", () => {
  it("returns registry_url from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "registry_url" ? "https://npm.pkg.github.com/" : ""));
    expect(registry.url()).toBe("https://npm.pkg.github.com/");
  });

  it("returns default registry URL when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(registry.url()).toBe("https://registry.npmjs.org/");
  });

  it("returns registry_scope from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "registry_scope" ? "@my-org" : ""));
    expect(registry.scope()).toBe("@my-org");
  });

  it("returns default scope when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(registry.scope()).toBe("@krashidbuilt");
  });

  it("returns registry_auth_token from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "registry_auth_token" ? "npm_abc123" : ""));
    expect(registry.authToken()).toBe("npm_abc123");
  });

  it("falls back to GITHUB_TOKEN when auth_token input is empty", () => {
    mockGetInput.mockReturnValue("");
    mockGetToken.mockReturnValue("ghp_token123");
    expect(registry.authToken()).toBe("ghp_token123");
  });

  it("returns empty string when both auth_token and GITHUB_TOKEN are empty", () => {
    mockGetInput.mockReturnValue("");
    mockGetToken.mockReturnValue(undefined);
    expect(registry.authToken()).toBe("");
  });
});

describe("git", () => {
  it("returns git_user_name from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "git_user_name" ? "My Bot" : ""));
    expect(git.userName()).toBe("My Bot");
  });

  it("returns default user name when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(git.userName()).toBe("github-actions[bot]");
  });

  it("returns git_user_email from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "git_user_email" ? "bot@me.com" : ""));
    expect(git.userEmail()).toBe("bot@me.com");
  });

  it("returns default user email when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(git.userEmail()).toBe("github-actions[bot]@users.noreply.github.com");
  });
});

describe("build", () => {
  it("returns build_directory from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "build_directory" ? "out" : ""));
    expect(build.directory()).toBe("out");
  });

  it("returns default build directory when input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(build.directory()).toBe("dist");
  });
});

describe("common", () => {
  it("returns working_directory from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "working_directory" ? "packages/web" : ""));
    expect(common.workingDirectory()).toBe("packages/web");
  });

  it("returns '.' as default working directory", () => {
    mockGetInput.mockReturnValue("");
    expect(common.workingDirectory()).toBe(".");
  });

  it("returns github_token from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "github_token" ? "ghp_custom" : ""));
    expect(common.githubToken()).toBe("ghp_custom");
  });

  it("falls back to GITHUB_TOKEN env var for githubToken", () => {
    mockGetInput.mockReturnValue("");
    mockGetToken.mockReturnValue("ghp_env");
    expect(common.githubToken()).toBe("ghp_env");
  });

  it("returns empty string when github_token and env are both empty", () => {
    mockGetInput.mockReturnValue("");
    mockGetToken.mockReturnValue(undefined);
    expect(common.githubToken()).toBe("");
  });

  it("returns environment from input when provided", () => {
    mockGetInput.mockImplementation((name: string) => (name === "environment" ? "alpha" : ""));
    expect(common.environment()).toBe("alpha");
  });

  it("returns undefined when environment input is empty", () => {
    mockGetInput.mockReturnValue("");
    expect(common.environment()).toBeUndefined();
  });
});

describe("inputs namespace", () => {
  it("contains all input groups", () => {
    expect(inputs.runtime).toBe(runtime);
    expect(inputs.aws).toBe(aws);
    expect(inputs.registry).toBe(registry);
    expect(inputs.git).toBe(git);
    expect(inputs.build).toBe(build);
    expect(inputs.common).toBe(common);
  });
});
