/**
 * Invalidate CloudFront Cache Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { AWS } from "../../../core/constants.js";

export const config = defineAction({
  name: "Invalidate CloudFront Cache",
  description: "Invalidates the CloudFront cache for a frontend application",
  inputs: {
    environment: {
      description: "Target environment (alpha, beta, production)",
      required: true,
    },
    app_name: {
      description: "Application name (used to find the S3 bucket and CloudFront distribution)",
      required: true,
    },
    paths: {
      description: "Paths to invalidate (comma-separated, default: /*)",
      default: "/*",
    },
    aws_region: {
      description: "AWS region",
      default: AWS.REGION,
    },
  },
  outputs: {
    invalidation_id: {
      description: "CloudFront invalidation ID",
    },
    distribution_id: {
      description: "CloudFront distribution ID",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type InvalidateCacheConfig = typeof config;
