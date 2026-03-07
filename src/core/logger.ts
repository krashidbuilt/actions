/**
 * Logging utilities for GitHub Actions
 */

import * as core from "@actions/core";

export interface LoggerOptions {
  prefix?: string;
  debug?: boolean;
}

export class Logger {
  private prefix: string;
  private debugEnabled: boolean;

  constructor(options: LoggerOptions = {}) {
    this.prefix = options.prefix ? `[${options.prefix}]` : "";
    this.debugEnabled = options.debug ?? core.isDebug();
  }

  private format(message: string): string {
    return this.prefix ? `${this.prefix} ${message}` : message;
  }

  debug(message: string, data?: unknown): void {
    if (this.debugEnabled) {
      const formatted = this.format(message);
      if (data !== undefined) {
        core.debug(`${formatted}: ${JSON.stringify(data, null, 2)}`);
      } else {
        core.debug(formatted);
      }
    }
  }

  info(message: string, data?: unknown): void {
    const formatted = this.format(message);
    if (data !== undefined) {
      core.info(`${formatted}: ${JSON.stringify(data)}`);
    } else {
      core.info(formatted);
    }
  }

  warn(message: string, data?: unknown): void {
    const formatted = this.format(message);
    if (data !== undefined) {
      core.warning(`${formatted}: ${JSON.stringify(data)}`);
    } else {
      core.warning(formatted);
    }
  }

  error(message: string, error?: unknown): void {
    const formatted = this.format(message);
    if (error instanceof Error) {
      core.error(`${formatted}: ${error.message}`);
      if (error.stack) {
        core.debug(error.stack);
      }
    } else if (error !== undefined) {
      core.error(`${formatted}: ${JSON.stringify(error)}`);
    } else {
      core.error(formatted);
    }
  }

  startGroup(name: string): void {
    core.startGroup(this.format(name));
  }

  endGroup(): void {
    core.endGroup();
  }

  async group<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return core.group(this.format(name), fn);
  }
}

export const logger = new Logger();
