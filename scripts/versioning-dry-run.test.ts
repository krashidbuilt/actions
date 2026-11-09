import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { dryRunPublish, parseOutputs } from "./versioning-dry-run.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseOutputs", () => {
  it("reads GITHUB_OUTPUT heredoc blocks", () => {
    const text = "version<<ghadelimiter_1\n0.1.0\nghadelimiter_1\ntag<<ghadelimiter_2\nv0.1.0\nghadelimiter_2\n";
    expect(parseOutputs(text)).toEqual({ version: "0.1.0", tag: "v0.1.0" });
  });
});

// The krashidbuilt/http history of 2026-11-09, rebuilt: package.json 0.0.0, a feat commit
// (first run), then a fix commit (second run, after v0.1.0 was tagged).
describe("dryRunPublish on a new repo's first releases", () => {
  let repo: string;
  let first: string;
  let second: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "versioning-dry-run-test-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "@krashidbuilt/x", version: "0.0.0" })}\n`);
    git("add", "package.json");
    git("commit", "-q", "-m", "feat: first cut");
    first = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "index.ts"), "export {};\n");
    git("add", "index.ts");
    git("commit", "-q", "-m", "fix: second cut");
    second = git("rev-parse", "HEAD");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("tags the first release with the version it publishes", () => {
    expect(dryRunPublish(repo, { ref: first })).toEqual({ published: "0.1.0", tag: "v0.1.0", tagged: "0.1.0" });
  });

  it("reproduces the old mismatch when the record step recomputes", () => {
    expect(dryRunPublish(repo, { ref: first, legacy: true })).toMatchObject({ published: "0.1.0", tag: "v0.2.0" });
  });

  it("patches from the tag on the second release", () => {
    expect(dryRunPublish(repo, { ref: second, tags: { "v0.1.0": first } })).toEqual({
      published: "0.1.1",
      tag: "v0.1.1",
      tagged: "0.1.1",
    });
  });

  it("releases nothing when no commit since the tag bumps", () => {
    expect(dryRunPublish(repo, { ref: first, tags: { "v0.1.0": first } })).toEqual({
      published: "",
      tag: "",
      tagged: "",
    });
  });
});

describe("reusable-typescript-publish.yml", () => {
  it("hands the computed version to the step that tags and releases", () => {
    const workflow = parse(readFileSync(join(rootDir, ".github/workflows/reusable-typescript-publish.yml"), "utf8"));
    const steps: Array<{ name?: string; uses?: string; with?: Record<string, unknown> }> = workflow.jobs.publish.steps;
    const record = steps.find((s) => s.name === "Record the release");
    expect(record?.uses).toBe("krashidbuilt/actions/versioning@v1");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(record?.with?.version).toBe("${{ steps.version.outputs.version }}");
  });
});
