import { describe, expect, it, vi } from "vitest";

import { isRetryableError, retryWithBackoff } from "./retry.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

describe("isRetryableError", () => {
  it("returns true for 429 status", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it("returns true for 403 with rate limit message", () => {
    expect(isRetryableError({ status: 403, message: "You have exceeded a secondary rate limit" })).toBe(true);
  });

  it("returns true for rate limit message without status", () => {
    expect(isRetryableError({ message: "rate limit exceeded" })).toBe(true);
  });

  it("returns false for 403 without rate limit message", () => {
    expect(isRetryableError({ status: 403, message: "Forbidden" })).toBe(false);
  });

  it("returns false for 404", () => {
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  it("returns false for non-object errors", () => {
    expect(isRetryableError("error string")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError(42)).toBe(false);
  });
});

describe("retryWithBackoff", () => {
  it("returns result on first try", async () => {
    const fn = vi.fn().mockResolvedValue("success");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error", async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 429, message: "rate limited" }).mockResolvedValue("success");

    const result = await retryWithBackoff(fn, { retries: 3, delay: 1 });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws immediately for non-retryable errors", async () => {
    const error = { status: 404, message: "Not found" };
    const fn = vi.fn().mockRejectedValue(error);

    await expect(retryWithBackoff(fn, { retries: 3, delay: 1 })).rejects.toEqual(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries", async () => {
    const error = { status: 429, message: "rate limited" };
    const fn = vi.fn().mockRejectedValue(error);

    await expect(retryWithBackoff(fn, { retries: 2, delay: 1 })).rejects.toEqual(error);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("uses custom isRetryable function", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue("done");

    const result = await retryWithBackoff(fn, {
      retries: 3,
      delay: 1,
      isRetryable: (err) => err instanceof Error && err.message === "temporary",
    });

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
