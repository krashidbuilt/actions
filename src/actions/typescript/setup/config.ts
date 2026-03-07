/**
 * TypeScript Setup Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { REGISTRY, RUNTIME } from "../../../core/constants.js";

export const config = defineAction({
  name: "TypeScript Setup",
  description: "Sets up Node.js, Bun, and configures npm registry authentication",
  inputs: {
    node_version: {
      description: "Node.js version to install",
      default: RUNTIME.NODE_VERSION,
    },
    bun_version: {
      description: "Bun version to install",
      default: RUNTIME.BUN_VERSION,
    },
    registry_url: {
      description: "NPM registry URL",
      default: REGISTRY.URL,
    },
    registry_scope: {
      description: "NPM registry scope",
      default: REGISTRY.SCOPE,
    },
    registry_auth_token: {
      description: "Registry authentication token (defaults to GITHUB_TOKEN)",
    },
    working_directory: {
      description: "Working directory",
      default: ".",
    },
  },
  outputs: {
    package_manager: {
      description: "Detected package manager (npm, yarn, or bun)",
    },
    node_version: {
      description: "Installed Node.js version",
    },
    bun_version: {
      description: "Installed Bun version",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type TypeScriptSetupConfig = typeof config;
