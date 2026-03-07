/**
 * Retry utility with exponential backoff
 */

import { Logger } from "./logger.js";

const logger = new Logger({ prefix: "retry" });

export interface RetryOptions {
  retries?: number;
  delay?: number;
  isRetryable?: (error: unknown) => boolean;
}

interface GitHubError {
  status?: number;
  message?: string;
}

function isGitHubError(error: unknown): error is GitHubError {
  return typeof error === "object" && error !== null && ("status" in error || "message" in error);
}

export function isRetryableError(error: unknown): boolean {
  if (!isGitHubError(error)) return false;

  const hasRateLimitMessage =
    error.message?.includes("rate limit") ||
    error.message?.includes("You have exceeded a secondary rate limit") ||
    false;

  if (error.status === 429) return true;
  if (error.status === 403 && hasRateLimitMessage) return true;

  return !error.status && hasRateLimitMessage;
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 5, delay = 5000, isRetryable = isRetryableError } = options;

  let lastError: unknown;
  let currentDelay = delay;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === retries || !isRetryable(error)) {
        throw error;
      }

      logger.warn(`Retryable error detected. Retrying in ${currentDelay}ms... (${retries - attempt} retries left)`);
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
      currentDelay *= 2;
    }
  }

  throw lastError;
}
