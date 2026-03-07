/**
 * Detect App Info Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";

export const config = defineAction({
  name: "Detect App Info",
  description: "Detects application name and version from package.json",
  inputs: {
    working_directory: {
      description: "Working directory",
      default: ".",
    },
    app_name: {
      description: "Override app name (auto-detected from package.json if not set)",
    },
    version_override: {
      description: "Override version (auto-detected if not set)",
    },
    strip_scope: {
      description: "Strip npm scope from package name",
      default: "true",
    },
  },
  outputs: {
    app_name: {
      description: "Application name",
    },
    version: {
      description: "Application version",
    },
    tag: {
      description: "Version tag (e.g., v1.0.0)",
    },
    package_name: {
      description: "Original package name from package.json",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type DetectAppInfoConfig = typeof config;
