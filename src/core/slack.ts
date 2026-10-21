/**
 * Slack deploy notifications.
 *
 * Ported from karaconnect/actions (core/slack.ts) and made host-aware: every
 * link is built from GITHUB_SERVER_URL, so the same code posts correct run,
 * tag and PR links from Gitea (git.dsm.krashidbuilt.com) and from GitHub
 * (fifth-gear-tech callers of the public mirror). Talks to the Slack Web API
 * with fetch, so the bundle carries no Slack SDK.
 */

import { readFileSync } from "node:fs";
import { Logger } from "./logger.js";
import type { Environment } from "./types.js";

const logger = new Logger({ prefix: "slack" });

export type NotifyStatus = "pending" | "success" | "failed" | "cancelled";

const STATUS_COLORS: Record<NotifyStatus, string> = {
  pending: "#cccccc",
  success: "#36a64f",
  failed: "#dc3545",
  cancelled: "#6c757d",
};

const STATUS_EMOJI: Record<NotifyStatus, string> = {
  pending: "⏳",
  success: "✅",
  failed: "❌",
  cancelled: "🚫",
};

/** Slack rejects a section block whose text is over 3000 characters. */
export const SLACK_TEXT_LIMIT = 3000;

/**
 * Accepts our own status names and the values of `${{ job.status }}`
 * (success | failure | cancelled), so a workflow can pass job.status straight in.
 */
export function normalizeStatus(raw: string | undefined): NotifyStatus {
  const value = (raw || "pending").trim().toLowerCase();
  if (value === "failure") return "failed";
  if (value === "pending" || value === "success" || value === "failed" || value === "cancelled") return value;
  throw new Error(`Invalid status: ${raw}. Use pending, success, failed, cancelled (or a job.status value).`);
}

export interface RunContext {
  serverUrl: string;
  apiUrl: string;
  repository: string;
  runId: string;
  actor: string;
  sha: string;
  ref: string;
  eventName: string;
  eventPath?: string;
  isGitea: boolean;
}

export function readRunContext(env: NodeJS.ProcessEnv = process.env): RunContext {
  const serverUrl = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
  const defaultApi = serverUrl === "https://github.com" ? "https://api.github.com" : `${serverUrl}/api/v1`;
  return {
    serverUrl,
    apiUrl: (env.GITHUB_API_URL || defaultApi).replace(/\/$/, ""),
    repository: env.GITHUB_REPOSITORY || "",
    runId: env.GITHUB_RUN_ID || "",
    actor: env.GITHUB_ACTOR || "",
    sha: env.GITHUB_SHA || "",
    ref: env.GITHUB_REF || "",
    eventName: env.GITHUB_EVENT_NAME || "",
    eventPath: env.GITHUB_EVENT_PATH || undefined,
    isGitea: env.GITEA_ACTIONS === "true",
  };
}

/** Converts GitHub-flavoured markdown (PR bodies) to Slack mrkdwn. */
export function toSlackMrkdwn(markdown: string | null | undefined): string {
  if (!markdown) return "";
  return (
    markdown
      .replace(/\r\n/g, "\n")
      // Review-comment artifacts GitHub leaves in bodies
      .replace(/\[\[\d+\]\]\(diffhunk:\/\/[^)]+\)/g, "")
      // HTML comments (PR templates)
      .replace(/<!--[\s\S]*?-->/g, "")
      // [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
      // Headings → bold
      .replace(/^#{1,6}\s*(.+)$/gm, "*$1*")
      // **bold** / __bold__ → *bold*
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/__([^_\n]+)__/g, "*$1*")
      // Bullets → •
      .replace(/^\s*[*-]\s+/gm, "• ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export interface PrInfo {
  number?: number;
  title: string;
  body: string;
  url: string;
}

/** Title in bold, then the body, cut to fit one Slack section block. */
export function formatPrDescription(pr: Pick<PrInfo, "title" | "body">): string {
  const title = pr.title ? `*${pr.title}*` : "";
  const body = toSlackMrkdwn(pr.body);
  const combined = title && body ? `${title}\n\n${body}` : title || body;
  if (combined.length <= SLACK_TEXT_LIMIT) return combined;
  return `${combined.slice(0, SLACK_TEXT_LIMIT - 1)}…`;
}

/** PR number from a GitHub (/pull/N) or Gitea (/pulls/N) URL. */
export function prNumberFromUrl(url: string): string | undefined {
  return url.match(/\/pulls?\/(\d+)/)?.[1];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RawPr {
  number?: number;
  title?: string | null;
  body?: string | null;
  html_url?: string;
  base?: { ref?: string };
}

function toPrInfo(pr: RawPr | null | undefined): PrInfo | null {
  if (!pr?.html_url) return null;
  return { number: pr.number, title: pr.title || "", body: pr.body || "", url: pr.html_url };
}

function readEventPullRequest(eventPath: string | undefined): RawPr | null {
  if (!eventPath) return null;
  try {
    const payload = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: RawPr };
    return payload.pull_request ?? null;
  } catch (error) {
    logger.debug("Could not read the event payload", { eventPath, error: String(error) });
    return null;
  }
}

/**
 * The PR behind this run: the event's own PR for pull_request runs, otherwise
 * the PR that merged the commit being deployed. Gitea answers
 * /commits/{sha}/pull with one PR; GitHub answers /commits/{sha}/pulls with a
 * list, where the PR targeting the deployed branch wins (a promotion PR shares
 * commits with older PRs into other branches). Never throws: no PR is not an error.
 */
export async function findPullRequest(
  ctx: RunContext,
  token: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<PrInfo | null> {
  if (ctx.eventName === "pull_request" || ctx.eventName === "pull_request_target") {
    return toPrInfo(readEventPullRequest(ctx.eventPath));
  }
  // A tag has no target branch, and any PR found for it would be a guess.
  if (!token || !ctx.sha || !ctx.repository || ctx.ref.startsWith("refs/tags/")) return null;

  const branch = ctx.ref.startsWith("refs/heads/") ? ctx.ref.slice("refs/heads/".length) : "";
  const path = ctx.isGitea ? "pull" : "pulls";
  const url = `${ctx.apiUrl}/repos/${ctx.repository}/commits/${ctx.sha}/${path}`;

  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `token ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      logger.debug("No PR for commit", { url, status: res.status });
      return null;
    }
    const data = (await res.json()) as RawPr | RawPr[];
    if (!Array.isArray(data)) return toPrInfo(data);
    const match = (branch && data.find((pr) => pr.base?.ref === branch)) || data[0];
    return toPrInfo(match);
  } catch (error) {
    logger.warn(`PR lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export interface DeployNotice {
  status: NotifyStatus;
  environment?: Environment | string;
  projectName?: string;
  version?: string;
  pr?: PrInfo | null;
  /** Release notes shown under the card; defaults to the PR description on a finished production deploy. */
  description?: string;
  text?: string;
}

export interface SlackMessage {
  text: string;
  attachments: object[];
  blocks?: object[];
}

/** Production deploys that finished carry the release notes; everything else is just the card. */
export function shouldIncludeDescription(notice: DeployNotice): boolean {
  return notice.environment === "production" && (notice.status === "success" || notice.status === "failed");
}

export function buildMessage(ctx: RunContext, notice: DeployNotice): SlackMessage {
  const [owner = "", repo = ""] = ctx.repository.split("/");
  const repoUrl = `${ctx.serverUrl}/${ctx.repository}`;
  const runUrl = `${repoUrl}/actions/runs/${ctx.runId}`;
  const project = notice.projectName || repo;
  const status = notice.status;
  const env = notice.environment ? String(notice.environment).toUpperCase() : "";

  const fields: Array<{ title: string; value: string; short: boolean }> = [
    { title: "Project", value: `<${repoUrl}|${project}>`, short: true },
    { title: "Initiator", value: ctx.actor ? `<${ctx.serverUrl}/${ctx.actor}|${ctx.actor}>` : "—", short: true },
    { title: "Status", value: `<${runUrl}|${status.toUpperCase()}>`, short: true },
  ];
  if (env) fields.push({ title: "Environment", value: env, short: true });
  if (notice.version) {
    const tag = notice.version.startsWith("v") ? notice.version : `v${notice.version}`;
    fields.push({ title: "Tag", value: `<${repoUrl}/releases/tag/${tag}|${notice.version}>`, short: true });
  }
  if (notice.pr?.url) {
    const number = notice.pr.number ?? prNumberFromUrl(notice.pr.url);
    fields.push({ title: "Pull Request", value: `<${notice.pr.url}|#${number ?? "PR"}>`, short: true });
  }

  const summary = [STATUS_EMOJI[status], project, notice.version, env && `→ ${env}`, status.toUpperCase()]
    .filter(Boolean)
    .join(" ");

  const attachment = {
    color: STATUS_COLORS[status],
    fallback: summary,
    fields,
    actions: [{ type: "button", text: "View Run", url: runUrl }],
    footer: `<${runUrl}|${owner}/${repo}>`,
    footer_icon: ctx.isGitea
      ? `${ctx.serverUrl}/assets/img/favicon.png`
      : "https://github.githubassets.com/favicon.ico",
    ts: Math.floor(Date.now() / 1000),
  };

  const description = shouldIncludeDescription(notice)
    ? notice.description || (notice.pr ? formatPrDescription(notice.pr) : "")
    : "";

  return {
    text: notice.text || summary,
    attachments: [attachment],
    ...(description && { blocks: [{ type: "section", text: { type: "mrkdwn", text: description } }] }),
  };
}

/** Production deploys go to production_channel when one is set; everything else to channel. */
export function pickChannel(opts: {
  channel?: string;
  productionChannel?: string;
  environment?: string;
}): string | undefined {
  const pick = opts.environment === "production" && opts.productionChannel ? opts.productionChannel : opts.channel;
  return pick?.replace(/^#/, "") || undefined;
}

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}

export async function slackCall<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new SlackApiError(method, `http_${res.status}`);
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new SlackApiError(method, data.error || "unknown_error");
  return data;
}

const CHANNEL_ID = /^[CGD][A-Z0-9]{8,}$/;

/** A channel id passes through; a name is looked up (the bot needs channels:read, groups:read for private). */
export async function resolveChannelId(token: string, channel: string, fetchImpl: FetchLike = fetch): Promise<string> {
  if (CHANNEL_ID.test(channel)) return channel;
  const name = channel.replace(/^#/, "");
  let cursor: string | undefined;
  do {
    const page = await slackCall<{
      channels?: Array<{ id: string; name: string }>;
      response_metadata?: { next_cursor?: string };
    }>(
      token,
      "conversations.list",
      { types: "public_channel,private_channel", exclude_archived: true, limit: 1000, ...(cursor && { cursor }) },
      fetchImpl,
    );
    const hit = page.channels?.find((c) => c.name === name);
    if (hit) return hit.id;
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  throw new Error(`Slack channel #${name} not found (is the bot invited, with channels:read?)`);
}

export interface SlackPostResult {
  messageId: string;
  channelId: string;
}

/** Posts a new message, or updates messageId in place (pending → success/failed). */
export async function postOrUpdate(
  token: string,
  channelId: string,
  message: SlackMessage,
  messageId?: string,
  fetchImpl: FetchLike = fetch,
): Promise<SlackPostResult> {
  const method = messageId ? "chat.update" : "chat.postMessage";
  const payload = { channel: channelId, ...message, unfurl_links: false, ...(messageId && { ts: messageId }) };
  const res = await slackCall<{ ts: string; channel?: string }>(token, method, payload, fetchImpl);
  return { messageId: res.ts, channelId: res.channel || channelId };
}
