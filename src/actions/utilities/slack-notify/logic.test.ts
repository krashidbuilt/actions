import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "./logic.js";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  isDebug: vi.fn(() => false),
}));

const ENV_KEYS = ["GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_SHA", "GITEA_ACTIONS"] as const;

function setInputs(values: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => values[name] ?? "");
}

function outputs(): Record<string, string> {
  return Object.fromEntries(vi.mocked(core.setOutput).mock.calls.map(([k, v]) => [k, String(v)]));
}

describe("slack-notify run", () => {
  const saved: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.GITHUB_SERVER_URL = "https://git.dsm.krashidbuilt.com";
    process.env.GITHUB_REPOSITORY = "krashidbuilt/kairos";
    process.env.GITHUB_REF = "refs/heads/production";
    process.env.GITHUB_SHA = "";
    process.env.GITEA_ACTIONS = "true";
    fetchMock = vi.fn(async (url: string) => {
      const body = url.endsWith("chat.update") ? { ok: true, ts: "1.5" } : { ok: true, ts: "1.5", channel: "C123" };
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it("skips quietly without a token", async () => {
    setInputs({ status: "pending" });
    await run();
    expect(outputs()).toEqual({ skipped: "true" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("logs instead of sending on a dry run", async () => {
    setInputs({ dry_run: "true", status: "success" });
    await run();
    expect(outputs()).toEqual({ skipped: "true" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the production channel and reports the ids", async () => {
    setInputs({
      slack_bot_token: "xoxb-1",
      status: "pending",
      channel: "C0DEPLOYS1",
      production_channel: "C0PRODUCT1",
      version: "1.0.0",
    });
    await run();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(init.body).channel).toBe("C0PRODUCT1");
    expect(outputs()).toEqual({ message_id: "1.5", channel_id: "C123", skipped: "false" });
  });

  it("updates the earlier message with the job status", async () => {
    setInputs({ slack_bot_token: "xoxb-1", status: "failure", channel_id: "C0DEPLOYS1", message_id: "1.5" });
    await run();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(init.body).text).toContain("FAILED");
    expect(outputs()).toMatchObject({ message_id: "1.5", channel_id: "C0DEPLOYS1" });
  });

  it("warns and sends nothing when no channel resolves", async () => {
    setInputs({ slack_bot_token: "xoxb-1", channel: "#" });
    await run();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("no channel configured"));
    expect(outputs()).toEqual({ skipped: "true" });
  });

  it("never fails the job on a Slack error", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "not_in_channel" })));
    setInputs({ slack_bot_token: "xoxb-1", channel: "C0DEPLOYS1" });
    await run();
    expect(core.warning).toHaveBeenCalledWith("slack-notify: Slack chat.postMessage failed: not_in_channel");
    expect(outputs()).toEqual({ skipped: "true" });
  });

  it("reports a bad status as a warning", async () => {
    setInputs({ slack_bot_token: "xoxb-1", status: "nope" });
    await run();
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Invalid status"));
  });

  it("stringifies non-Error throws", async () => {
    fetchMock.mockImplementation(async () => {
      throw "socket hang up";
    });
    setInputs({ slack_bot_token: "xoxb-1", channel: "C0DEPLOYS1" });
    await run();
    expect(core.warning).toHaveBeenCalledWith("slack-notify: socket hang up");
  });
});
