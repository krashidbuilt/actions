import { describe, expect, it, vi } from "vitest";

const { mockInfo, mockDebug, mockWarning, mockError, mockStartGroup, mockEndGroup, mockGroup, mockIsDebug } =
  vi.hoisted(() => ({
    mockInfo: vi.fn(),
    mockDebug: vi.fn(),
    mockWarning: vi.fn(),
    mockError: vi.fn(),
    mockStartGroup: vi.fn(),
    mockEndGroup: vi.fn(),
    mockGroup: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    mockIsDebug: vi.fn(() => false),
  }));

vi.mock("@actions/core", () => ({
  info: mockInfo,
  debug: mockDebug,
  warning: mockWarning,
  error: mockError,
  startGroup: mockStartGroup,
  endGroup: mockEndGroup,
  group: mockGroup,
  isDebug: mockIsDebug,
}));

import { Logger, logger } from "./logger.js";

describe("Logger", () => {
  describe("constructor", () => {
    it("creates logger with no prefix by default", () => {
      const log = new Logger();
      log.info("test");
      expect(mockInfo).toHaveBeenCalledWith("test");
    });

    it("creates logger with prefix when provided", () => {
      const log = new Logger({ prefix: "mymod" });
      log.info("test");
      expect(mockInfo).toHaveBeenCalledWith("[mymod] test");
    });

    it("uses core.isDebug() when debug option is not specified", () => {
      mockIsDebug.mockReturnValue(true);
      const log = new Logger();
      log.debug("test");
      expect(mockDebug).toHaveBeenCalledWith("test");
    });

    it("respects explicit debug=true option", () => {
      mockIsDebug.mockReturnValue(false);
      const log = new Logger({ debug: true });
      log.debug("test");
      expect(mockDebug).toHaveBeenCalledWith("test");
    });

    it("respects explicit debug=false option", () => {
      mockIsDebug.mockReturnValue(true);
      const log = new Logger({ debug: false });
      log.debug("test");
      expect(mockDebug).not.toHaveBeenCalled();
    });
  });

  describe("debug", () => {
    it("logs debug message when debug is enabled", () => {
      const log = new Logger({ debug: true });
      log.debug("hello");
      expect(mockDebug).toHaveBeenCalledWith("hello");
    });

    it("does not log debug message when debug is disabled", () => {
      const log = new Logger({ debug: false });
      log.debug("hello");
      expect(mockDebug).not.toHaveBeenCalled();
    });

    it("logs debug with prefix", () => {
      const log = new Logger({ prefix: "mod", debug: true });
      log.debug("hello");
      expect(mockDebug).toHaveBeenCalledWith("[mod] hello");
    });

    it("logs debug with data", () => {
      const log = new Logger({ debug: true });
      log.debug("data", { key: "value" });
      expect(mockDebug).toHaveBeenCalledWith('data: {\n  "key": "value"\n}');
    });

    it("logs debug with prefix and data", () => {
      const log = new Logger({ prefix: "mod", debug: true });
      log.debug("data", { key: "value" });
      expect(mockDebug).toHaveBeenCalledWith('[mod] data: {\n  "key": "value"\n}');
    });

    it("does not log data when debug is disabled", () => {
      const log = new Logger({ debug: false });
      log.debug("data", { key: "value" });
      expect(mockDebug).not.toHaveBeenCalled();
    });
  });

  describe("info", () => {
    it("logs info message", () => {
      const log = new Logger();
      log.info("hello");
      expect(mockInfo).toHaveBeenCalledWith("hello");
    });

    it("logs info with prefix", () => {
      const log = new Logger({ prefix: "mod" });
      log.info("hello");
      expect(mockInfo).toHaveBeenCalledWith("[mod] hello");
    });

    it("logs info with data (JSON stringified)", () => {
      const log = new Logger();
      log.info("data", { key: "value" });
      expect(mockInfo).toHaveBeenCalledWith('data: {"key":"value"}');
    });

    it("logs info with prefix and data", () => {
      const log = new Logger({ prefix: "mod" });
      log.info("data", [1, 2, 3]);
      expect(mockInfo).toHaveBeenCalledWith("[mod] data: [1,2,3]");
    });
  });

  describe("warn", () => {
    it("logs warning message", () => {
      const log = new Logger();
      log.warn("careful");
      expect(mockWarning).toHaveBeenCalledWith("careful");
    });

    it("logs warning with prefix", () => {
      const log = new Logger({ prefix: "mod" });
      log.warn("careful");
      expect(mockWarning).toHaveBeenCalledWith("[mod] careful");
    });

    it("logs warning with data", () => {
      const log = new Logger();
      log.warn("data", { issues: 3 });
      expect(mockWarning).toHaveBeenCalledWith('data: {"issues":3}');
    });

    it("logs warning with prefix and data", () => {
      const log = new Logger({ prefix: "mod" });
      log.warn("data", "string-value");
      expect(mockWarning).toHaveBeenCalledWith('[mod] data: "string-value"');
    });
  });

  describe("error", () => {
    it("logs error message", () => {
      const log = new Logger();
      log.error("failure");
      expect(mockError).toHaveBeenCalledWith("failure");
    });

    it("logs error with prefix", () => {
      const log = new Logger({ prefix: "mod" });
      log.error("failure");
      expect(mockError).toHaveBeenCalledWith("[mod] failure");
    });

    it("logs Error instance with message and stack", () => {
      const log = new Logger();
      const err = new Error("something broke");
      log.error("operation failed", err);
      expect(mockError).toHaveBeenCalledWith("operation failed: something broke");
      expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining("Error: something broke"));
    });

    it("logs Error instance with prefix", () => {
      const log = new Logger({ prefix: "mod" });
      const err = new Error("something broke");
      log.error("op failed", err);
      expect(mockError).toHaveBeenCalledWith("[mod] op failed: something broke");
    });

    it("logs Error instance without stack when stack is undefined", () => {
      const log = new Logger();
      const err = new Error("no stack");
      err.stack = undefined;
      log.error("op failed", err);
      expect(mockError).toHaveBeenCalledWith("op failed: no stack");
      expect(mockDebug).not.toHaveBeenCalled();
    });

    it("logs non-Error object as JSON", () => {
      const log = new Logger();
      log.error("op failed", { code: 404 });
      expect(mockError).toHaveBeenCalledWith('op failed: {"code":404}');
    });

    it("logs non-Error object with prefix", () => {
      const log = new Logger({ prefix: "mod" });
      log.error("op failed", "string-error");
      expect(mockError).toHaveBeenCalledWith('[mod] op failed: "string-error"');
    });

    it("logs number as error data", () => {
      const log = new Logger();
      log.error("exit code", 1);
      expect(mockError).toHaveBeenCalledWith("exit code: 1");
    });
  });

  describe("startGroup", () => {
    it("calls core.startGroup with message", () => {
      const log = new Logger();
      log.startGroup("section");
      expect(mockStartGroup).toHaveBeenCalledWith("section");
    });

    it("calls core.startGroup with prefixed message", () => {
      const log = new Logger({ prefix: "mod" });
      log.startGroup("section");
      expect(mockStartGroup).toHaveBeenCalledWith("[mod] section");
    });
  });

  describe("endGroup", () => {
    it("calls core.endGroup", () => {
      const log = new Logger();
      log.endGroup();
      expect(mockEndGroup).toHaveBeenCalledTimes(1);
    });
  });

  describe("group", () => {
    it("delegates to core.group with formatted name", async () => {
      const log = new Logger();
      const fn = vi.fn(async () => 42);

      const result = await log.group("section", fn);

      expect(mockGroup).toHaveBeenCalledWith("section", fn);
      expect(result).toBe(42);
    });

    it("passes prefixed name to core.group", async () => {
      const log = new Logger({ prefix: "mod" });
      const fn = vi.fn(async () => "result");

      await log.group("section", fn);
      expect(mockGroup).toHaveBeenCalledWith("[mod] section", fn);
    });
  });

  describe("default logger export", () => {
    it("is a Logger instance with no prefix", () => {
      expect(logger).toBeInstanceOf(Logger);
      logger.info("test from default");
      expect(mockInfo).toHaveBeenCalledWith("test from default");
    });
  });
});
