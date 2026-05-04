/**
 * Configure AWS Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";
import { AWS } from "../../../core/constants.js";

export const config = defineAction({
  name: "Configure AWS",
  description:
    "Configures AWS credentials for a specific environment. Supports three auth paths: static-only, AssumeRole-by-deployer-key (Gitea), and OIDC AssumeRoleWithWebIdentity (GitHub).",
  inputs: {
    environment: {
      description: "Target environment (alpha, beta, production)",
      required: true,
    },
    role_arn: {
      description:
        "Full IAM role ARN to assume. If empty, falls back to aws_account_id + role_scope, then AWS_ROLE_ARN env var. Omit entirely for static-only path.",
    },
    aws_account_id: {
      description:
        "AWS account ID. Combined with role_scope to construct arn:aws:iam::<account>:role/deploy-<scope>. Ignored when role_arn is set.",
    },
    role_scope: {
      description:
        "Role scope: 'app' for application deploys (S3 + CloudFront + Lambda update), 'infra' for infrastructure repos (full CFN + IAM). Combined with aws_account_id.",
    },
    aws_region: {
      description: "AWS region",
      default: AWS.REGION,
    },
    session_duration: {
      description:
        "STS assume-role session duration in seconds (900-43200). Default 3600 (1 hour). Long deploys must chain refresh, not extend.",
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
