/**
 * Slack Notify Action Configuration
 */

import { defineAction } from "../../../core/action-config.js";

export const config = defineAction({
  name: "Slack Notify",
  description:
    "Posts a deploy/release card to Slack and updates it in place. A no-op when slack_bot_token is empty, so callers can wire it in before the token exists.",
  inputs: {
    slack_bot_token: {
      description: "Slack bot token (xoxb-…). Empty = skip quietly.",
    },
    status: {
      description: "pending | success | failed | cancelled, or a job.status value (failure maps to failed)",
      default: "pending",
    },
    channel: {
      description: "Channel name or id for non-production deploys (and production when production_channel is empty)",
      default: "deployments",
    },
    production_channel: {
      description: "Channel name or id for production deploys",
    },
    channel_id: {
      description: "Channel id from an earlier step's output (skips the name lookup; required with message_id)",
    },
    message_id: {
      description: "Message ts from an earlier step's output; when set the message is updated instead of posted",
    },
    environment: {
      description: "alpha | beta | production (auto-detected from the branch when empty)",
    },
    project_name: {
      description: "Project name on the card (defaults to the repo name)",
    },
    version: {
      description: "Version being deployed; links to its release tag",
    },
    github_token: {
      description: "Token for looking up the PR behind the deployed commit (Gitea or GitHub)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an Actions expression, not a JS template
      default: "${{ github.token }}",
    },
    pr_description: {
      description: "Release notes for a finished production deploy (defaults to the PR's title + body)",
    },
    dry_run: {
      description: "Log the message instead of sending it",
      default: "false",
    },
  },
  outputs: {
    message_id: {
      description: "Slack message ts (pass to a later step to update it)",
    },
    channel_id: {
      description: "Slack channel id",
    },
    skipped: {
      description: "true when nothing was sent (no token)",
    },
  },
  runs: {
    using: "node24",
    main: "dist/index.js",
  },
});

export type SlackNotifyConfig = typeof config;
