/**
 * Configure AWS Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { AWS } from "../../../core/constants.js";

export const config = defineAction({
  name: "Configure AWS",
  description: "Configures AWS credentials for a specific environment",
  inputs: {
    environment: {
      description: "Target environment (alpha, beta, production)",
      required: true,
    },
    role_arn: {
      description: "IAM role ARN for OIDC federation (defaults to AWS_ROLE_ARN env var)",
    },
    aws_region: {
      description: "AWS region",
      default: AWS.REGION,
    },
  },
  outputs: {
    account_id: {
      description: "AWS account ID",
    },
    region: {
      description: "AWS region",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type ConfigureAwsConfig = typeof config;
