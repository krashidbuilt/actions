/**
 * TypeScript Publish Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";

export const config = defineAction({
  name: "TypeScript Publish",
  description: "Builds and publishes an npm package using bun publish",
  inputs: {
    working_directory: {
      description: "Working directory containing the package to publish",
      default: ".",
    },
    tag: {
      description: "npm dist-tag (alpha, beta, or latest)",
      required: true,
    },
    skip_build: {
      description: "Skip running build before publish",
      default: "false",
    },
  },
  outputs: {
    published: {
      description: "Whether the package was published",
    },
    version: {
      description: "Published version",
    },
    tag: {
      description: "NPM tag used",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type TypeScriptPublishConfig = typeof config;
