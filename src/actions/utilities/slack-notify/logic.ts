/**
 * Slack Notify Action - Business Logic
 *
 * One call posts a card; a second call with the first call's message_id and
 * channel_id updates it (pending → success/failed). Workflows do that with an
 * explicit `if: always()` step passing `${{ job.status }}` rather than an
 * action post-step, which keeps it identical on Gitea's act_runner and GitHub.
 *
 * A notification never fails the job: a deploy that worked stays green when
 * Slack is down or the channel is missing. Problems surface as warnings.
 */

import * as core from "@actions/core";
import { createInputs, detectEnvironmentFromRef, github, Logger } from "../../../core/index.js";
import {
  buildMessage,
  findPullRequest,
  normalizeStatus,
  pickChannel,
  postOrUpdate,
  readRunContext,
  resolveChannelId,
} from "../../../core/slack.js";
import { config } from "./config.js";

const logger = new Logger({ prefix: "slack-notify" });

function skip(): void {
  core.setOutput("skipped", "true");
}

export async function run(): Promise<void> {
  const inputs = createInputs(config);
  try {
    const token = inputs.getOptional("slack_bot_token");
    const dryRun = inputs.getBool("dry_run");
    if (!token && !dryRun) {
      logger.info("No slack_bot_token — skipping the Slack notification");
      skip();
      return;
    }

    const ctx = readRunContext();
    const status = normalizeStatus(inputs.get("status"));
    const environment =
      inputs.getOptional("environment") || detectEnvironmentFromRef(github.getRefForEnvironment() || "") || undefined;
    const pr = await findPullRequest(ctx, inputs.getOptional("github_token"));

    const message = buildMessage(ctx, {
      status,
      environment,
      projectName: inputs.getOptional("project_name"),
      version: inputs.getOptional("version"),
      pr,
      description: inputs.getOptional("pr_description"),
    });

    const messageId = inputs.getOptional("message_id");
    const channel =
      inputs.getOptional("channel_id") ||
      pickChannel({
        channel: inputs.get("channel"),
        productionChannel: inputs.getOptional("production_channel"),
        environment,
      });

    if (dryRun || !token) {
      logger.info("[DRY RUN] Would send", { channel, messageId, status, environment, pr: pr?.url, message });
      skip();
      return;
    }
    if (!channel) {
      core.warning("slack-notify: no channel configured — nothing sent");
      skip();
      return;
    }

    const channelId = await resolveChannelId(token, channel);
    const result = await postOrUpdate(token, channelId, message, messageId);
    core.setOutput("message_id", result.messageId);
    core.setOutput("channel_id", result.channelId);
    core.setOutput("skipped", "false");
    logger.info(`Slack message ${messageId ? "updated" : "posted"}`, { ...result, status, environment });
  } catch (error) {
    core.warning(`slack-notify: ${error instanceof Error ? error.message : String(error)}`);
    skip();
  }
}
