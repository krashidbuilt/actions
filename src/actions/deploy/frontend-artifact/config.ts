/**
 * Deploy Frontend Artifact Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { AWS } from "../../../core/constants.js";

export const config = defineAction({
  name: "Deploy Frontend Artifact",
  description: "Deploys a specific version from the artifact bucket to S3/CloudFront (for rollbacks and promotions)",
  inputs: {
    environment: {
      description: "Target environment",
      required: true,
    },
    version: {
      description: "Version to deploy from artifact bucket",
      required: true,
    },
    app_name: {
      description: "Application name",
      required: true,
    },
    aws_region: {
      description: "AWS region",
      default: AWS.REGION,
    },
    github_token: {
      description: "GitHub token",
    },
    invalidate_cache: {
      description:
        "Whether to invalidate CloudFront cache after deployment (default: true to prevent white screen issues from stale cache)",
      default: "true",
    },
  },
  outputs: {
    environment: {
      description: "Deployed environment",
    },
    version: {
      description: "Deployed version",
    },
    app_name: {
      description: "Application name",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type DeployFrontendArtifactConfig = typeof config;
