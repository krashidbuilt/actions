import { describe, expect, it, vi } from "vitest";

const { mockGetInput, mockSetOutput } = vi.hoisted(() => ({
  mockGetInput: vi.fn(() => ""),
  mockSetOutput: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  getInput: mockGetInput,
  setOutput: mockSetOutput,
}));

import { createInputs, createOutputs, defineAction } from "./action-config.js";

const testConfig = defineAction({
  name: "Test Action",
  description: "A test action",
  inputs: {
    name: { description: "Name input", required: true },
    optional_input: { description: "Optional input" },
    bool_input: { description: "Boolean input", default: "false" },
    defaulted: { description: "Has a default", default: "fallback" },
  },
  outputs: {
    result: { description: "The result" },
    status: { description: "The status" },
  },
  runs: { using: "node24", main: "dist/index.js" },
});

describe("defineAction", () => {
  it("returns the config as-is", () => {
    expect(testConfig.name).toBe("Test Action");
    expect(testConfig.description).toBe("A test action");
    expect(testConfig.runs.using).toBe("node24");
    expect(testConfig.runs.main).toBe("dist/index.js");
  });

  it("preserves input definitions", () => {
    expect(testConfig.inputs?.name.required).toBe(true);
    expect(testConfig.inputs?.defaulted.default).toBe("fallback");
  });
});

describe("createInputs", () => {
  const inputs = createInputs(testConfig);

  it("get() returns core.getInput value", () => {
    mockGetInput.mockReturnValueOnce("hello");
    expect(inputs.get("name")).toBe("hello");
  });

  it("get() falls back to default when empty", () => {
    mockGetInput.mockReturnValueOnce("");
    expect(inputs.get("defaulted")).toBe("fallback");
  });

  it("get() returns empty string when no value and no default", () => {
    mockGetInput.mockReturnValueOnce("");
    expect(inputs.get("optional_input")).toBe("");
  });

  it("getOptional() returns value when present", () => {
    mockGetInput.mockReturnValueOnce("value");
    expect(inputs.getOptional("name")).toBe("value");
  });

  it("getOptional() returns undefined when empty", () => {
    mockGetInput.mockReturnValueOnce("");
    expect(inputs.getOptional("name")).toBeUndefined();
  });

  it("getRequired() calls core.getInput with required option", () => {
    mockGetInput.mockReturnValueOnce("required-value");
    expect(inputs.getRequired("name")).toBe("required-value");
    expect(mockGetInput).toHaveBeenCalledWith("name", { required: true });
  });

  it("getBool() returns true for 'true'", () => {
    mockGetInput.mockReturnValueOnce("true");
    expect(inputs.getBool("bool_input")).toBe(true);
  });

  it("getBool() returns false for other values", () => {
    mockGetInput.mockReturnValueOnce("false");
    expect(inputs.getBool("bool_input")).toBe(false);

    mockGetInput.mockReturnValueOnce("");
    expect(inputs.getBool("bool_input")).toBe(false);
  });

  it("getBoolWithDefault() returns default when input is empty", () => {
    mockGetInput.mockReturnValueOnce("");
    expect(inputs.getBoolWithDefault("bool_input", true)).toBe(true);

    mockGetInput.mockReturnValueOnce("");
    expect(inputs.getBoolWithDefault("bool_input", false)).toBe(false);
  });

  it("getBoolWithDefault() uses input value when present", () => {
    mockGetInput.mockReturnValueOnce("true");
    expect(inputs.getBoolWithDefault("bool_input", false)).toBe(true);

    mockGetInput.mockReturnValueOnce("false");
    expect(inputs.getBoolWithDefault("bool_input", true)).toBe(false);
  });
});

describe("createOutputs", () => {
  const outputs = createOutputs(testConfig);

  it("set() calls core.setOutput", () => {
    outputs.set("result", "success");
    expect(mockSetOutput).toHaveBeenCalledWith("result", "success");
  });

  it("set() works with different output names", () => {
    outputs.set("status", "completed");
    expect(mockSetOutput).toHaveBeenCalledWith("status", "completed");
  });
});
