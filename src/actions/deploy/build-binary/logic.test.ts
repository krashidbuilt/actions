import { describe, expect, it, type Mock, vi } from "vitest";

const { mockExec, mockGetInput, mockSetOutput, mockSetFailed } = vi.hoisted(() => ({
  mockExec: vi.fn(async () => 0) as Mock,
  mockGetInput: vi.fn((_name: string, _options?: { required?: boolean }) => "") as Mock,
  mockSetOutput: vi.fn(),
  mockSetFailed: vi.fn(),
}));

vi.mock("@actions/exec", () => ({
  exec: mockExec,
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

const mockWorkingDirectory = vi.fn(() => ".");

vi.mock("../../../core/index.js", () => ({
  common: {
    workingDirectory: () => mockWorkingDirectory(),
  },
  Logger: class {
    info = vi.fn();
    debug = vi.fn();
    warn = vi.fn();
    error = vi.fn();
  },
}));

import { getInputs, run } from "./logic.js";

describe("getInputs", () => {
  it("reads all required inputs", () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        entry: "src/main.ts",
        target: "bun-linux-x64",
        outfile: "my-binary",
      };
      return inputs[name] || "";
    });
    mockWorkingDirectory.mockReturnValue("/workspace");

    const inputs = getInputs();

    expect(inputs.entry).toBe("src/main.ts");
    expect(inputs.target).toBe("bun-linux-x64");
    expect(inputs.outfile).toBe("my-binary");
    expect(inputs.workingDirectory).toBe("/workspace");
  });

  it("uses default working directory when not specified", () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        entry: "index.ts",
        target: "bun-darwin-arm64",
        outfile: "bin",
      };
      return inputs[name] || "";
    });
    mockWorkingDirectory.mockReturnValue(".");

    const inputs = getInputs();
    expect(inputs.workingDirectory).toBe(".");
  });
});

describe("run", () => {
  it("executes bun build with correct arguments and sets output", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        entry: "src/daemon.ts",
        target: "bun-linux-x64",
        outfile: "daemon",
      };
      return inputs[name] || "";
    });
    mockWorkingDirectory.mockReturnValue(".");

    await run();

    expect(mockExec).toHaveBeenCalledWith(
      "bun",
      ["build", "--compile", "--target", "bun-linux-x64", "--outfile", "daemon", "src/daemon.ts"],
      expect.objectContaining({ cwd: expect.any(String) }),
    );

    expect(mockSetOutput).toHaveBeenCalledWith("artifact_path", expect.stringContaining("daemon"));
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("resolves working directory to an absolute path", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        entry: "index.ts",
        target: "bun-linux-x64",
        outfile: "out/bin",
      };
      return inputs[name] || "";
    });
    mockWorkingDirectory.mockReturnValue("packages/daemon");

    await run();

    const execCall = mockExec.mock.calls[0];
    const options = execCall[2] as { cwd: string };
    expect(options.cwd).toMatch(/packages\/daemon$/);
    // Artifact path should be resolved from workingDir + outfile
    expect(mockSetOutput).toHaveBeenCalledWith("artifact_path", expect.stringContaining("out/bin"));
  });

  it("calls setFailed with error message when exec throws an Error", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        entry: "src/main.ts",
        target: "bun-linux-x64",
        outfile: "binary",
      };
      return inputs[name] || "";
    });
    mockWorkingDirectory.mockReturnValue(".");
    mockExec.mockRejectedValue(new Error("bun build failed: module not found"));

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("bun build failed: module not found");
    expect(mockSetOutput).not.toHaveBeenCalled();
  });

  it("calls setFailed with generic message when a non-Error is thrown", async () => {
    mockGetInput.mockImplementation((name: string) => {
      const inputs: Record<string, string> = {
        entry: "src/main.ts",
        target: "bun-linux-x64",
        outfile: "binary",
      };
      return inputs[name] || "";
    });
    mockWorkingDirectory.mockReturnValue(".");
    mockExec.mockRejectedValue("string error");

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith("An unexpected error occurred");
  });
});
