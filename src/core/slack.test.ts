import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  buildMessage,
  findPullRequest,
  formatPrDescription,
  normalizeStatus,
  pickChannel,
  postOrUpdate,
  prNumberFromUrl,
  type RunContext,
  readRunContext,
  resolveChannelId,
  SLACK_TEXT_LIMIT,
  SlackApiError,
  shouldIncludeDescription,
  slackCall,
  toSlackMrkdwn,
} from "./slack.js";

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

const GITEA = "https://git.dsm.krashidbuilt.com";

function giteaCtx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    serverUrl: GITEA,
    apiUrl: `${GITEA}/api/v1`,
    repository: "krashidbuilt/kairos",
    runId: "5249",
    actor: "ben",
    sha: "abc123",
    ref: "refs/heads/production",
    eventName: "push",
    isGitea: true,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("normalizeStatus", () => {
  it("maps job.status values", () => {
    expect(normalizeStatus("success")).toBe("success");
    expect(normalizeStatus("failure")).toBe("failed");
    expect(normalizeStatus("Cancelled")).toBe("cancelled");
  });

  it("defaults to pending", () => {
    expect(normalizeStatus(undefined)).toBe("pending");
    expect(normalizeStatus("")).toBe("pending");
  });

  it("rejects anything else", () => {
    expect(() => normalizeStatus("done")).toThrow(/Invalid status/);
  });
});

describe("readRunContext", () => {
  it("reads a Gitea run", () => {
    const ctx = readRunContext({
      GITHUB_SERVER_URL: `${GITEA}/`,
      GITHUB_API_URL: `${GITEA}/api/v1`,
      GITHUB_REPOSITORY: "krashidbuilt/kairos",
      GITHUB_RUN_ID: "77",
      GITHUB_ACTOR: "ben",
      GITHUB_SHA: "abc",
      GITHUB_REF: "refs/heads/develop",
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: "/tmp/event.json",
      GITEA_ACTIONS: "true",
    });
    expect(ctx).toMatchObject({
      serverUrl: GITEA,
      apiUrl: `${GITEA}/api/v1`,
      repository: "krashidbuilt/kairos",
      runId: "77",
      isGitea: true,
      eventPath: "/tmp/event.json",
    });
  });

  it("defaults to github.com", () => {
    const ctx = readRunContext({});
    expect(ctx.serverUrl).toBe("https://github.com");
    expect(ctx.apiUrl).toBe("https://api.github.com");
    expect(ctx.isGitea).toBe(false);
    expect(ctx.eventPath).toBeUndefined();
  });

  it("derives the Gitea API URL when GITHUB_API_URL is missing", () => {
    expect(readRunContext({ GITHUB_SERVER_URL: GITEA }).apiUrl).toBe(`${GITEA}/api/v1`);
  });
});

describe("toSlackMrkdwn", () => {
  it("converts links, headings, bold and bullets", () => {
    const md = "## Summary\r\n**Bold** and __also__\n- one\n* two\n[PR](https://x.test/pulls/3)";
    expect(toSlackMrkdwn(md)).toBe("*Summary*\n*Bold* and *also*\n• one\n• two\n<https://x.test/pulls/3|PR>");
  });

  it("drops HTML comments, diffhunk artifacts and extra blank lines", () => {
    expect(toSlackMrkdwn("a<!-- template -->\n\n\n\nb [[1]](diffhunk://x)")).toBe("a\n\nb");
  });

  it("handles empty input", () => {
    expect(toSlackMrkdwn(null)).toBe("");
    expect(toSlackMrkdwn(undefined)).toBe("");
  });
});

describe("formatPrDescription", () => {
  it("puts the title in bold above the body", () => {
    expect(formatPrDescription({ title: "promote", body: "- fix" })).toBe("*promote*\n\n• fix");
  });

  it("works with only one of title or body", () => {
    expect(formatPrDescription({ title: "t", body: "" })).toBe("*t*");
    expect(formatPrDescription({ title: "", body: "b" })).toBe("b");
  });

  it("fits one section block", () => {
    const out = formatPrDescription({ title: "t", body: "x".repeat(5000) });
    expect(out.length).toBe(SLACK_TEXT_LIMIT);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("prNumberFromUrl", () => {
  it("reads Gitea and GitHub PR URLs", () => {
    expect(prNumberFromUrl(`${GITEA}/krashidbuilt/kairos/pulls/12`)).toBe("12");
    expect(prNumberFromUrl("https://github.com/o/r/pull/95")).toBe("95");
    expect(prNumberFromUrl("https://example.test")).toBeUndefined();
  });
});

describe("findPullRequest", () => {
  it("uses the event payload on pull_request runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slack-test-"));
    const eventPath = join(dir, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({ pull_request: { number: 4, title: "t", body: null, html_url: "https://x/pulls/4" } }),
    );
    const fetchImpl = vi.fn();
    const pr = await findPullRequest(giteaCtx({ eventName: "pull_request", eventPath }), "tok", fetchImpl);
    expect(pr).toEqual({ number: 4, title: "t", body: "", url: "https://x/pulls/4" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when the event payload is unreadable", async () => {
    expect(await findPullRequest(giteaCtx({ eventName: "pull_request", eventPath: "/nope.json" }), "t")).toBeNull();
    expect(await findPullRequest(giteaCtx({ eventName: "pull_request_target" }), "t")).toBeNull();
  });

  it("asks Gitea for the single PR behind the commit", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ number: 9, title: "promote", body: "notes", html_url: `${GITEA}/krashidbuilt/kairos/pulls/9` }),
    );
    const pr = await findPullRequest(giteaCtx(), "tok", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${GITEA}/api/v1/repos/krashidbuilt/kairos/commits/abc123/pull`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "token tok" }) }),
    );
    expect(pr?.number).toBe(9);
  });

  it("prefers the GitHub PR that targets the deployed branch", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json([
        { number: 1, title: "old", html_url: "https://github.com/o/r/pull/1", base: { ref: "develop" } },
        { number: 2, title: "promote", html_url: "https://github.com/o/r/pull/2", base: { ref: "production" } },
      ]),
    );
    const ctx = giteaCtx({ isGitea: false, apiUrl: "https://api.github.com", repository: "o/r" });
    const pr = await findPullRequest(ctx, "tok", fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/o/r/commits/abc123/pulls");
    expect(pr?.number).toBe(2);
  });

  it("falls back to the first GitHub PR, and null for none", async () => {
    const ctx = giteaCtx({ isGitea: false, ref: "refs/heads/feature" });
    const first = vi.fn(async (_url: string, _init?: RequestInit) =>
      json([{ number: 7, html_url: "https://github.com/o/r/pull/7" }]),
    );
    expect((await findPullRequest(ctx, "t", first))?.number).toBe(7);
    expect(
      await findPullRequest(
        ctx,
        "t",
        vi.fn(async (_url: string, _init?: RequestInit) => json([])),
      ),
    ).toBeNull();
    expect(
      await findPullRequest(
        giteaCtx({ ref: "" }),
        "t",
        vi.fn(async (_url: string, _init?: RequestInit) => json([])),
      ),
    ).toBeNull();
  });

  it("returns null without a token, sha, or on a tag", async () => {
    const fetchImpl = vi.fn();
    expect(await findPullRequest(giteaCtx(), undefined, fetchImpl)).toBeNull();
    expect(await findPullRequest(giteaCtx({ sha: "" }), "t", fetchImpl)).toBeNull();
    expect(await findPullRequest(giteaCtx({ ref: "refs/tags/v1.0.0" }), "t", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a 404 or a network error", async () => {
    expect(
      await findPullRequest(
        giteaCtx(),
        "t",
        vi.fn(async (_url: string, _init?: RequestInit) => json({}, 404)),
      ),
    ).toBeNull();
    const boom = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new Error("ECONNREFUSED");
    });
    expect(await findPullRequest(giteaCtx(), "t", boom)).toBeNull();
    const weird = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw "string failure";
    });
    expect(await findPullRequest(giteaCtx(), "t", weird)).toBeNull();
  });
});

describe("buildMessage", () => {
  const pr = { number: 9, title: "promote: staging → production", body: "## What\n- fix", url: `${GITEA}/x/pulls/9` };

  it("builds the deploy card with Gitea links", () => {
    const msg = buildMessage(giteaCtx(), { status: "pending", environment: "beta", version: "1.2.3", pr });
    const [att] = msg.attachments as Array<Record<string, unknown>>;
    expect(att?.color).toBe("#cccccc");
    expect(att?.footer).toBe(`<${GITEA}/krashidbuilt/kairos/actions/runs/5249|krashidbuilt/kairos>`);
    expect(att?.footer_icon).toBe(`${GITEA}/assets/img/favicon.png`);
    expect(att?.fields).toEqual([
      { title: "Project", value: `<${GITEA}/krashidbuilt/kairos|kairos>`, short: true },
      { title: "Initiator", value: `<${GITEA}/ben|ben>`, short: true },
      { title: "Status", value: `<${GITEA}/krashidbuilt/kairos/actions/runs/5249|PENDING>`, short: true },
      { title: "Environment", value: "BETA", short: true },
      { title: "Tag", value: `<${GITEA}/krashidbuilt/kairos/releases/tag/v1.2.3|1.2.3>`, short: true },
      { title: "Pull Request", value: `<${GITEA}/x/pulls/9|#9>`, short: true },
    ]);
    expect(msg.text).toBe("⏳ kairos 1.2.3 → BETA PENDING");
    expect(msg.blocks).toBeUndefined();
  });

  it("adds release notes to a finished production deploy", () => {
    const msg = buildMessage(giteaCtx(), { status: "success", environment: "production", pr });
    expect(msg.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "*promote: staging → production*\n\n*What*\n• fix" } },
    ]);
    const custom = buildMessage(giteaCtx(), { status: "failed", environment: "production", pr, description: "notes" });
    expect(custom.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: "notes" } }]);
  });

  it("keeps a GitHub card minimal when little is known", () => {
    const ctx = giteaCtx({ isGitea: false, serverUrl: "https://github.com", repository: "o/r", actor: "" });
    const msg = buildMessage(ctx, {
      status: "cancelled",
      projectName: "app",
      version: "v2.0.0",
      pr: { title: "", body: "", url: "https://github.com/o/r/pull/5" },
      text: "custom",
    });
    const [att] = msg.attachments as Array<{ fields: Array<{ title: string; value: string }>; footer_icon: string }>;
    expect(att?.footer_icon).toBe("https://github.githubassets.com/favicon.ico");
    expect(att?.fields.map((f) => f.title)).toEqual(["Project", "Initiator", "Status", "Tag", "Pull Request"]);
    expect(att?.fields[1]?.value).toBe("—");
    expect(att?.fields[3]?.value).toBe("<https://github.com/o/r/releases/tag/v2.0.0|v2.0.0>");
    expect(att?.fields[4]?.value).toBe("<https://github.com/o/r/pull/5|#5>");
    expect(msg.text).toBe("custom");
  });

  it("falls back to #PR when the URL has no number", () => {
    const msg = buildMessage(giteaCtx(), { status: "success", pr: { title: "", body: "", url: "https://x" } });
    const [att] = msg.attachments as Array<{ fields: Array<{ value: string }> }>;
    expect(att?.fields.at(-1)?.value).toBe("<https://x|#PR>");
  });

  it("omits notes when there is no PR", () => {
    expect(buildMessage(giteaCtx(), { status: "success", environment: "production" }).blocks).toBeUndefined();
    expect(buildMessage(giteaCtx({ repository: "" }), { status: "success" }).text).toBe("✅ SUCCESS");
  });
});

describe("shouldIncludeDescription", () => {
  it("only for finished production deploys", () => {
    expect(shouldIncludeDescription({ status: "success", environment: "production" })).toBe(true);
    expect(shouldIncludeDescription({ status: "pending", environment: "production" })).toBe(false);
    expect(shouldIncludeDescription({ status: "success", environment: "beta" })).toBe(false);
  });
});

describe("pickChannel", () => {
  it("routes production to production_channel", () => {
    expect(pickChannel({ channel: "deployments", productionChannel: "#prod", environment: "production" })).toBe("prod");
    expect(pickChannel({ channel: "#deployments", productionChannel: "prod", environment: "beta" })).toBe(
      "deployments",
    );
    expect(pickChannel({ channel: "deployments", environment: "production" })).toBe("deployments");
    expect(pickChannel({})).toBeUndefined();
  });
});

describe("slackCall", () => {
  it("posts JSON with the bearer token", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true, ts: "1.2" }));
    const res = await slackCall<{ ts: string }>("xoxb-1", "chat.postMessage", { a: 1 }, fetchImpl);
    expect(res.ts).toBe("1.2");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        method: "POST",
        body: '{"a":1}',
        headers: expect.objectContaining({ Authorization: "Bearer xoxb-1" }),
      }),
    );
  });

  it("throws SlackApiError on ok:false and HTTP errors", async () => {
    await expect(
      slackCall(
        "t",
        "chat.update",
        {},
        vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: false, error: "not_in_channel" })),
      ),
    ).rejects.toThrow("Slack chat.update failed: not_in_channel");
    await expect(
      slackCall(
        "t",
        "x",
        {},
        vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: false })),
      ),
    ).rejects.toThrow("unknown_error");
    const err = await slackCall(
      "t",
      "x",
      {},
      vi.fn(async (_url: string, _init?: RequestInit) => json({}, 500)),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe("http_500");
  });
});

describe("resolveChannelId", () => {
  it("passes ids through", async () => {
    const fetchImpl = vi.fn();
    expect(await resolveChannelId("t", "C06DEV121J7", fetchImpl)).toBe("C06DEV121J7");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pages through conversations.list by name", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json({ ok: true, channels: [{ id: "C1", name: "general" }], response_metadata: { next_cursor: "n2" } }),
      )
      .mockResolvedValueOnce(json({ ok: true, channels: [{ id: "C2", name: "deployments" }] }));
    expect(await resolveChannelId("t", "#deployments", fetchImpl)).toBe("C2");
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string).cursor).toBe("n2");
  });

  it("explains a missing channel", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ ok: true, response_metadata: { next_cursor: "" } }),
    );
    await expect(resolveChannelId("t", "nope", fetchImpl)).rejects.toThrow(/#nope not found/);
  });
});

describe("postOrUpdate", () => {
  const message = { text: "hi", attachments: [] };

  it("posts a new message", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true, ts: "1.1", channel: "C9" }));
    expect(await postOrUpdate("t", "C9", message, undefined, fetchImpl)).toEqual({ messageId: "1.1", channelId: "C9" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.postMessage");
  });

  it("updates in place when given a message id", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => json({ ok: true, ts: "1.1" }));
    expect(await postOrUpdate("t", "C9", message, "1.1", fetchImpl)).toEqual({ messageId: "1.1", channelId: "C9" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string).ts).toBe("1.1");
  });
});
