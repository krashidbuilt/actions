/**
 * TypeScript Install Dependencies Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";

export const config = defineAction({
  name: "Install Dependencies",
  description: "Installs npm/yarn/bun dependencies with lockfile support",
  inputs: {
    package_manager: {
      description: "Package manager to use (npm, yarn, bun, or auto)",
      default: "auto",
    },
    working_directory: {
      description: "Working directory",
      default: ".",
    },
    frozen_lockfile: {
      description: "Use frozen lockfile (ci install)",
      default: "true",
    },
  },
  outputs: {
    package_manager: {
      description: "Detected/used package manager",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type TypeScriptInstallDependenciesConfig = typeof config;
