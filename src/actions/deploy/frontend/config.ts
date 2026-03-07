/**
 * Deploy Frontend Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { AWS, BUILD, RUNTIME } from "../../../core/constants.js";

export const config = defineAction({
  name: "Deploy Frontend",
  description: "Deploys frontend applications to S3/CloudFront with versioned artifact retention",
  inputs: {
    environment: {
      description: "Target environment (auto-detected from branch if not set)",
    },
    build_directory: {
      description: "Build output directory",
      default: BUILD.DIRECTORY,
    },
    working_directory: {
      description: "Working directory",
      default: ".",
    },
    node_version: {
      description: "Node.js version",
      default: RUNTIME.NODE_VERSION,
    },
    bun_version: {
      description: "Bun version",
      default: RUNTIME.BUN_VERSION,
    },
    aws_region: {
      description: "AWS region",
      default: AWS.REGION,
    },
    github_token: {
      description: "GitHub token",
    },
    app_name: {
      description: "Application name (auto-detected from package.json if not set)",
    },
    version: {
      description: "Deploy version (falls back to package.json version if not set)",
    },
    invalidate_cache: {
      description:
        "Whether to invalidate CloudFront cache after deployment (default: true to prevent white screen issues from stale cache)",
      default: "true",
    },
    invalidation_paths: {
      description:
        "Comma-separated list of paths to invalidate (default: '/*' for all). Example: '/index.html,/assets/*'",
      default: "/*",
    },
    versions_to_keep: {
      description: "Number of recent versions to retain in the site bucket",
      default: "3",
    },
  },
  outputs: {
    environment: {
      description: "Deployed environment",
    },
    version: {
      description: "Deployed version",
    },
    url: {
      description: "Deployment URL",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type DeployFrontendConfig = typeof config;
