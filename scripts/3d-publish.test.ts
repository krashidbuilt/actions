import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// scripts/3d-publish.sh end to end against a fake `aws` (scripts/testdata/fake-aws.py) whose
// bucket is a temp directory, plus its embedded python helper (brief parser, index, status).

const SCRIPTS = resolve(__dirname);
const SCRIPT = join(SCRIPTS, "3d-publish.sh");
const scriptText = readFileSync(SCRIPT, "utf-8");
const HELPER_SRC = scriptText.slice(scriptText.indexOf("<<'PY'\n") + 7, scriptText.indexOf("\nPY\n") + 1);
const HELPER = join(mkdtempSync(join(tmpdir(), "3d-helper-")), "3d-publish.py");
writeFileSync(HELPER, HELPER_SRC);

const BRIEF = `---
title: Book, MJF 13.75, shifter
summary: The slim slab in the leather cover with lever A.
status: checked
status_reason: Fit checks pass.
parent: aaa1111
numbers:
  - Stack, face to back: 13.75 mm
  - Closed in cover: 16.55 mm
links:
  - PR #20: https://git.example.com/o/r/pulls/20
  - README: Book context: https://git.example.com/o/r/src/branch/main/README.md#book-context
---

Intro text before the first section.

## What changed

- The cover is thinner.
- **Keys** moved to the face.

## Limitations

- Assumed switch force, see [README](https://git.example.com/x).

## Recommendation

The roll-only shifter with \`face keys\`.

## Notes

### Sub heading

| a | b |
|---|---|
| 1 | 2 |
`;

type Run = { status: number | null; stdout: string; stderr: string };

let tmp: string;
let s3: string;
let env: NodeJS.ProcessEnv;

function sh(args: string[], extra: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync("bash", [SCRIPT, "--bucket", "3d.example.com", "--distribution-id", "EFAKE1234", ...args], {
    env: { ...env, ...extra },
    encoding: "utf-8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function py(args: string[], extra: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync("python3", ["-I", HELPER, ...args], { encoding: "utf-8", env: { ...process.env, ...extra } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const obj = (key: string) => readFileSync(join(s3, key), "utf-8");
const json = (key: string) => JSON.parse(obj(key));
const has = (key: string) => existsSync(join(s3, key));
const meta = (key: string) => JSON.parse(readFileSync(join(tmp, "meta", `${key}.meta.json`), "utf-8"));
const calls = (): string[][] =>
  readFileSync(join(tmp, "aws.log"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const writes = () =>
  calls().filter(
    (c) => (c[0] === "s3" && (c[1] === "sync" || (c[1] === "cp" && c[3].startsWith("s3://")))) || c[0] === "cloudfront",
  );
const invalidated = () =>
  calls()
    .filter((c) => c[0] === "cloudfront")
    .flatMap((c) => c.slice(c.indexOf("--paths") + 1, c.indexOf("--query")));
const entry = (rev: string) => json("passport/index.json").revisions.find((r: any) => r.rev === rev);

function viewer(name: string, page = "<html><body><canvas></canvas></body></html>"): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "renders"), { recursive: true });
  writeFileSync(join(dir, "index.html"), page);
  writeFileSync(join(dir, "face.json"), "{}");
  writeFileSync(join(dir, "renders", "iso.png"), "png");
  writeFileSync(join(dir, "renders", "face_on.png"), "png");
  return dir;
}

function briefFile(name: string, text = BRIEF): string {
  const path = join(tmp, name);
  writeFileSync(path, text);
  return path;
}

function publish(rev: string, date: string, extra: string[] = [], envExtra: NodeJS.ProcessEnv = {}): Run {
  const dir = viewer(`v-${rev.replace(/\W/g, "_")}`);
  return sh(
    ["--project", "passport", "--rev", rev, "--dir", dir, "--renders", join(dir, "renders"), "--date", date, ...extra],
    envExtra,
  );
}

const snapshot = () => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(s3, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(s3);
  return out;
};
const changed = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "3d-publish-"));
  s3 = join(tmp, "bucket");
  mkdirSync(s3);
  mkdirSync(join(tmp, "meta"));
  mkdirSync(join(tmp, "bin"));
  symlinkSync(join(SCRIPTS, "testdata", "fake-aws.py"), join(tmp, "bin", "aws"));
  chmodSync(join(SCRIPTS, "testdata", "fake-aws.py"), 0o755);
  writeFileSync(join(tmp, "aws.log"), "");
  env = {
    PATH: `${join(tmp, "bin")}:${process.env.PATH}`,
    FAKE_S3: s3,
    FAKE_S3_META: join(tmp, "meta"),
    FAKE_AWS_LOG: join(tmp, "aws.log"),
  };
});

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("brief parser", () => {
  test("a valid brief parses into fields, sections and plain excerpts", () => {
    const out = join(tmp, "brief.json");
    const r = py([
      "brief",
      "build",
      briefFile("b.md"),
      "--project",
      "passport",
      "--rev",
      "bbb2222",
      "--at",
      "2026-11-05T10:00:00Z",
      "--out",
      out,
    ]);
    expect(r.status).toBe(0);
    const b = JSON.parse(readFileSync(out, "utf-8"));
    expect(b).toMatchObject({
      format: "3d-brief/1",
      project: "passport",
      rev: "bbb2222",
      at: "2026-11-05T10:00:00Z",
      title: "Book, MJF 13.75, shifter",
      status: "checked",
      statusReason: "Fit checks pass.",
      parent: "aaa1111",
      supersededBy: null,
      numbers: [
        { label: "Stack, face to back", value: "13.75 mm" },
        { label: "Closed in cover", value: "16.55 mm" },
      ],
      links: [
        { label: "PR #20", url: "https://git.example.com/o/r/pulls/20" },
        { label: "README: Book context", url: "https://git.example.com/o/r/src/branch/main/README.md#book-context" },
      ],
    });
    expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sections.map((s: any) => s.title)).toEqual([
      null,
      "What changed",
      "Limitations",
      "Recommendation",
      "Notes",
    ]);
    expect(b.sections[4].markdown).toContain("### Sub heading");
    expect(b.excerpt.limitations).toBe("• Assumed switch force, see README.");
    expect(b.excerpt.recommendation).toBe("The roll-only shifter with face keys.");
  });

  test("quoted scalars, CRLF and a BOM are accepted", () => {
    const text = `﻿${BRIEF.replace("title: Book, MJF 13.75, shifter", 'title: "Book: quoted"').replace(/\n/g, "\r\n")}`;
    expect(py(["brief", "validate", briefFile("crlf.md", text)]).status).toBe(0);
  });

  test.each([
    ["no front matter", "# hi\n", "starts with a front matter block"],
    ["unclosed front matter", "---\ntitle: x\n", "not closed"],
    ["missing title", BRIEF.replace(/^title:.*\n/m, ""), "'title' is required"],
    ["bad status", BRIEF.replace("status: checked", "status: done"), "'status' must be one of"],
    ["unknown key", BRIEF.replace("status: checked", "status: checked\nowner: ben"), "unknown key 'owner'"],
    ["duplicate key", BRIEF.replace("status: checked", "status: checked\nstatus: concept"), "'status' is given twice"],
    ["comment", BRIEF.replace("status: checked", "status: checked\n# note"), "comments are not allowed"],
    ["long summary", BRIEF.replace(/^summary:.*$/m, `summary: ${"x".repeat(201)}`), "'summary' is 201 characters"],
    ["superseded without successor", BRIEF.replace("status: checked", "status: superseded"), "needs 'superseded_by"],
    [
      "successor without superseded",
      BRIEF.replace("status: checked", "status: checked\nsuperseded_by: ccc3333"),
      "only for status 'superseded'",
    ],
    ["bad parent", BRIEF.replace("parent: aaa1111", "parent: ../x"), "'parent' must be a revision id"],
    ["reserved parent", BRIEF.replace("parent: aaa1111", "parent: status.json"), "'parent' must be a revision id"],
    ["number without label", BRIEF.replace("  - Closed in cover: 16.55 mm", "  - 16.55 mm"), "a number is"],
    [
      "link that is not http",
      BRIEF.replace("https://git.example.com/o/r/pulls/20", "javascript:alert(1)"),
      "a link is",
    ],
    [
      "item outside a list",
      BRIEF.replace("status: checked", "status: checked\n  - stray"),
      "outside 'numbers:' or 'links:'",
    ],
    ["inline list value", BRIEF.replace("numbers:", "numbers: 3"), "takes '  - label: value' items"],
    ["missing section", BRIEF.replace("## Limitations", "## Caveats"), "missing section '## Limitations'"],
    [
      "empty section",
      BRIEF.replace("The roll-only shifter with `face keys`.", ""),
      "section '## Recommendation' is empty",
    ],
    ["duplicate section", `${BRIEF}\n## Limitations\n\n- again\n`, "appears twice"],
    ["too many numbers", BRIEF.replace("numbers:", `numbers:\n${"  - n: 1\n".repeat(12)}`), "14 numbers (at most 12)"],
    ["too big", `${BRIEF}\n${"x".repeat(33 * 1024)}`, "over 32 KiB"],
  ])("rejects %s", (_name, text, message) => {
    const r = py(["brief", "validate", briefFile("bad.md", text)]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(message);
  });

  test("validate reports every file and fails when any is bad", () => {
    const r = py(["brief", "validate", briefFile("ok.md"), briefFile("bad.md", "nope")]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^ok {4}.*ok\.md$/m);
    expect(r.stdout).toMatch(/^error .*bad\.md:/m);
  });
});

describe("publish without a brief", () => {
  test("uploads the viewer, writes the same index entry (plus renders) and invalidates the same paths", () => {
    const r = publish("aaa1111", "2026-11-04T10:00:00Z", ["--title", "First"]);
    expect(r.status).toBe(0);
    expect(entry("aaa1111")).toEqual({
      rev: "aaa1111",
      date: "2026-11-04T10:00:00Z",
      title: "First",
      path: "/passport/aaa1111/",
      thumb: "/passport/aaa1111/renders/face_on.png",
      renders: ["face_on.png", "iso.png"],
    });
    // the page carries the (inert until a status exists) banner; nothing else changes
    expect(obj("passport/aaa1111/index.html")).toContain("3d-status-banner:start");
    expect(obj("passport/aaa1111/index.html")).toContain("<canvas></canvas>");
    expect(meta("passport/aaa1111/index.html")).toEqual({
      cacheControl: "no-cache",
      contentType: "text/html; charset=utf-8",
    });
    expect(has("passport/aaa1111/status.json")).toBe(false);
    expect(meta("passport/aaa1111/face.json").cacheControl).toBe("public, max-age=31536000, immutable");
    expect(json("index.json").projects[0].id).toBe("passport");
    expect(invalidated()).toEqual(["/index.json", "/index.html", "/", "/passport/*"]);
  });

  test("a publish of a listed rev is refused before anything is written", () => {
    expect(publish("aaa1111", "2026-11-04T10:00:00Z").status).toBe(0);
    writeFileSync(join(tmp, "aws.log"), "");
    const r = publish("aaa1111", "2026-11-05T10:00:00Z");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("aaa1111 is already published");
    expect(r.stderr).toContain("--brief");
    expect(writes()).toEqual([]);
  });

  test("an unreadable project index stops a publish (absent = a new project)", () => {
    expect(publish("aaa1111", "2026-11-04T10:00:00Z").status).toBe(0);
    writeFileSync(join(tmp, "aws.log"), "");
    const r = publish("bbb2222", "2026-11-05T10:00:00Z", [], { FAKE_AWS_FAIL_READ: "passport/index.json" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cannot read");
    expect(writes()).toEqual([]);
  });

  test("the single file runs on its own (copied out of the repo)", () => {
    const lone = join(tmp, "3d-publish.sh");
    writeFileSync(lone, scriptText);
    const r = spawnSync("bash", [lone, "--validate-brief", briefFile("ok.md")], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ok ");
    const bad = spawnSync("bash", [lone, "--validate-brief", briefFile("bad.md", "nope")], { encoding: "utf-8" });
    expect(bad.status).toBe(1);
  });

  test.each(["index.json", "brief.json", "status.json", "..", "a/b"])("refuses --rev %s", (rev) => {
    const r = publish(rev, "2026-11-04T10:00:00Z");
    expect(r.status).toBe(2);
    expect(writes()).toEqual([]);
  });
});

describe("briefs", () => {
  beforeEach(() => {
    expect(publish("aaa1111", "2026-11-04T10:00:00Z").status).toBe(0);
    expect(publish("bbb2222", "2026-11-05T10:00:00Z").status).toBe(0);
    writeFileSync(join(tmp, "aws.log"), "");
  });

  test("--brief on a published rev writes only brief.json, brief.md, status.json and the indexes", () => {
    const before = snapshot();
    const r = sh([
      "--project",
      "passport",
      "--rev",
      "bbb2222",
      "--brief",
      briefFile("b.md"),
      "--at",
      "2026-11-05T12:00:00Z",
    ]);
    expect(r.status).toBe(0);
    expect(json("passport/bbb2222/brief.json").title).toBe("Book, MJF 13.75, shifter");
    expect(obj("passport/bbb2222/brief.md")).toBe(BRIEF);
    expect(meta("passport/bbb2222/brief.json")).toEqual({ cacheControl: "no-cache", contentType: "application/json" });
    expect(meta("passport/bbb2222/brief.md").contentType).toBe("text/markdown; charset=utf-8");
    expect(json("passport/bbb2222/status.json")).toEqual({
      format: "3d-status/1",
      project: "passport",
      rev: "bbb2222",
      current: { value: "checked", at: "2026-11-05T12:00:00Z", reason: "Fit checks pass." },
      history: [{ value: "checked", at: "2026-11-05T12:00:00Z", reason: "Fit checks pass." }],
      dropped: 0,
    });
    const e = entry("bbb2222");
    expect(e.brief).toMatchObject({
      path: "/passport/bbb2222/brief.json",
      md: "/passport/bbb2222/brief.md",
      title: "Book, MJF 13.75, shifter",
      summary: "The slim slab in the leather cover with lever A.",
      at: "2026-11-05T12:00:00Z",
    });
    expect(e.status).toEqual({ value: "checked", at: "2026-11-05T12:00:00Z", reason: "Fit checks pass." });
    expect(e.statusPath).toBe("/passport/bbb2222/status.json");
    expect(e.parent).toBe("aaa1111");
    expect(e.updated).toBe("2026-11-05T12:00:00Z");
    expect(json("index.json").projects[0].revisions.find((r: any) => r.rev === "bbb2222").brief.sha256).toBe(
      e.brief.sha256,
    );
    expect(changed(before, snapshot())).toEqual([
      "index.json",
      "passport/bbb2222/brief.json",
      "passport/bbb2222/brief.md",
      "passport/bbb2222/status.json",
      "passport/index.json",
    ]);
    expect(calls().some((c) => c[1] === "sync")).toBe(false);
    expect(invalidated()).toEqual([
      "/index.json",
      "/passport/index.json",
      "/passport/bbb2222/brief.json",
      "/passport/bbb2222/brief.md",
      "/passport/bbb2222/status.json",
    ]);
  });

  test("the same brief again changes nothing; a different one is refused unless --replace-brief", () => {
    const b = briefFile("b.md");
    expect(sh(["--project", "passport", "--rev", "bbb2222", "--brief", b, "--at", "2026-11-05T12:00:00Z"]).status).toBe(
      0,
    );
    const before = entry("bbb2222");
    expect(sh(["--project", "passport", "--rev", "bbb2222", "--brief", b, "--at", "2026-11-06T00:00:00Z"]).status).toBe(
      0,
    );
    expect(entry("bbb2222")).toEqual(before);

    const changed = briefFile("b2.md", BRIEF.replace("The cover is thinner.", "The cover is much thinner."));
    const refused = sh(["--project", "passport", "--rev", "bbb2222", "--brief", changed]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("already has a different brief");
    expect(obj("passport/bbb2222/brief.md")).toBe(BRIEF);

    const fixed = sh([
      "--project",
      "passport",
      "--rev",
      "bbb2222",
      "--brief",
      changed,
      "--replace-brief",
      "--at",
      "2026-11-06T00:00:00Z",
    ]);
    expect(fixed.status).toBe(0);
    expect(obj("passport/bbb2222/brief.md")).toContain("much thinner");
    expect(entry("bbb2222").brief.replaced).toEqual([
      { at: "2026-11-06T00:00:00Z", sha256Before: before.brief.sha256 },
    ]);
    expect(json("passport/bbb2222/status.json").history).toHaveLength(1); // a correction is not a status change
  });

  test("an unknown rev, a missing parent or an unreadable index uploads nothing", () => {
    const b = briefFile("b.md");
    let r = sh(["--project", "passport", "--rev", "zzz9999", "--brief", b]);
    expect(r.status).toBe(2);
    r = sh(["--project", "passport", "--rev", "aaa1111", "--brief", b]); // parent = itself
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("parent 'aaa1111' must be another revision");
    r = sh(["--project", "passport", "--rev", "bbb2222", "--brief", b], { FAKE_AWS_FAIL_READ: "passport/index.json" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cannot read");
    r = sh(["--project", "passport", "--rev", "bbb2222", "--brief", briefFile("bad.md", "nope")]);
    expect(r.status).toBe(2);
    expect(writes()).toEqual([]);
  });

  test("a brief ships with a publish; a later re-publish is refused and leaves every file", () => {
    const dir = viewer("v-ccc");
    const args = ["--project", "passport", "--rev", "ccc3333", "--dir", dir, "--date", "2026-11-06T09:00:00Z"];
    let r = sh([...args, "--brief", briefFile("b.md")]);
    expect(r.status).toBe(0);
    expect(entry("ccc3333").status.at).toBe("2026-11-06T09:00:00Z"); // --at defaults to --date
    expect(entry("ccc3333").brief.title).toBe("Book, MJF 13.75, shifter");
    const page = obj("passport/ccc3333/index.html");
    expect(page.match(/3d-status-banner:start/g)).toHaveLength(1);
    expect(page.indexOf("3d-status-banner:end")).toBeLessThan(page.indexOf("</body>"));
    const before = snapshot();
    r = sh(args);
    expect(r.status).toBe(2);
    expect(changed(before, snapshot())).toEqual([]);
  });

  test("a set status survives a later first brief, and the history is never reset", () => {
    let r = sh([
      "--project",
      "passport",
      "--set-status",
      "bbb2222",
      "concept",
      "--reason",
      "first",
      "--at",
      "2026-11-05T11:00:00Z",
    ]);
    expect(r.status).toBe(0);
    r = sh(["--project", "passport", "--rev", "bbb2222", "--brief", briefFile("b.md"), "--at", "2026-11-05T12:00:00Z"]);
    expect(r.status).toBe(0);
    const doc = json("passport/bbb2222/status.json");
    expect(doc.history).toEqual([{ value: "concept", at: "2026-11-05T11:00:00Z", reason: "first" }]);
    expect(entry("bbb2222").status.value).toBe("concept");
    r = sh([
      "--project",
      "passport",
      "--set-status",
      "bbb2222",
      "checked",
      "--reason",
      "fit",
      "--at",
      "2026-11-05T13:00:00Z",
    ]);
    expect(json("passport/bbb2222/status.json").history.map((h: any) => h.value)).toEqual(["checked", "concept"]);
  });

  test("a brief lists renders already on the bucket for an older revision", () => {
    const old = json("passport/index.json");
    old.revisions = old.revisions.map(({ renders, ...r }: any) => r);
    writeFileSync(join(s3, "passport/index.json"), JSON.stringify(old));
    expect(sh(["--project", "passport", "--rev", "bbb2222", "--brief", briefFile("b.md")]).status).toBe(0);
    expect(entry("bbb2222").renders).toEqual(["face_on.png", "iso.png"]);
  });

  test("--dry-run writes nothing", () => {
    const r = sh(["--project", "passport", "--rev", "bbb2222", "--brief", briefFile("b.md"), "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dry-run: aws s3 cp");
    expect(has("passport/bbb2222/brief.json")).toBe(false);
    expect(writes()).toEqual([]);
  });
});

describe("--set-status", () => {
  beforeEach(() => {
    expect(publish("aaa1111", "2026-11-04T10:00:00Z").status).toBe(0);
    expect(publish("bbb2222", "2026-11-05T10:00:00Z").status).toBe(0);
    writeFileSync(join(tmp, "aws.log"), "");
  });

  const status = (args: string[]) => sh(["--project", "passport", "--set-status", ...args]);

  test("superseded needs a successor in the index and a reason", () => {
    expect(status(["aaa1111", "superseded", "--reason", "x"]).stderr).toContain("needs --superseded-by");
    expect(status(["aaa1111", "superseded", "--superseded-by", "zzz9999", "--reason", "x"]).stderr).toContain(
      "must be another revision",
    );
    expect(status(["aaa1111", "superseded", "--superseded-by", "aaa1111", "--reason", "x"]).status).toBe(2);
    expect(status(["aaa1111", "superseded", "--superseded-by", "bbb2222"]).stderr).toContain("needs --reason");
    expect(status(["aaa1111", "checked", "--superseded-by", "bbb2222", "--reason", "x"]).stderr).toContain(
      "only for status superseded",
    );
    expect(status(["aaa1111", "done", "--reason", "x"]).stderr).toContain("must be one of");
    expect(status(["zzz9999", "checked", "--reason", "x"]).status).toBe(2);
    expect(status(["status.json", "checked", "--reason", "x"]).status).toBe(2);
    expect(
      sh(["--project", "passport", "--set-status", "aaa1111", "checked", "--reason", "x", "--dir", "/tmp"]).status,
    ).toBe(2);
    expect(writes()).toEqual([]);
  });

  test("changes are kept newest first in status.json, copied to the index, shown on the page", () => {
    expect(status(["aaa1111", "checked", "--reason", "fit checks pass", "--at", "2026-11-04T12:00:00Z"]).status).toBe(
      0,
    );
    const r = status([
      "aaa1111",
      "superseded",
      "--superseded-by",
      "bbb2222",
      "--reason",
      "replaced by <b>bbb</b>",
      "--at",
      "2026-11-05T10:00:00Z",
    ]);
    expect(r.status).toBe(0);
    const doc = json("passport/aaa1111/status.json");
    expect(doc.current).toEqual({
      value: "superseded",
      at: "2026-11-05T10:00:00Z",
      reason: "replaced by <b>bbb</b>",
      supersededBy: "bbb2222",
    });
    expect(doc.history.map((h: any) => h.value)).toEqual(["superseded", "checked"]);
    const e = entry("aaa1111");
    expect(e.status.value).toBe("superseded");
    expect(e.supersededBy).toBe("bbb2222");
    expect(e.updated).toBe("2026-11-05T10:00:00Z");
    expect(e.statusHistory).toBeUndefined(); // history lives in status.json only
    expect(invalidated()).toContain("/passport/aaa1111/status.json");
    expect(calls().some((c) => c[1] === "sync" || (c[1] === "cp" && c[3]?.endsWith("index.html")))).toBe(false);

    writeFileSync(join(tmp, "aws.log"), "");
    expect(
      status(["aaa1111", "superseded", "--superseded-by", "bbb2222", "--reason", "replaced by <b>bbb</b>"]).status,
    ).toBe(0);
    expect(json("passport/aaa1111/status.json").history).toHaveLength(2); // a rerun is a no-op
    expect(calls().some((c) => c[1] === "cp" && c[3]?.startsWith("s3://") && c[3].endsWith("status.json"))).toBe(false);

    expect(status(["aaa1111", "checked", "--reason", "reinstated", "--at", "2026-11-06T00:00:00Z"]).status).toBe(0);
    expect(entry("aaa1111").supersededBy).toBeUndefined();
  });

  test("the history is bounded by bytes, oldest dropped and counted", () => {
    // The helper directly (the script around it is covered above): 70 changes of ~300 bytes.
    const index = join(tmp, "project.json");
    const file = join(tmp, "status.json");
    writeFileSync(index, obj("passport/index.json"));
    const reason = "r".repeat(290);
    for (let i = 0; i < 70; i++) {
      const at = `2026-11-${String(5 + Math.floor(i / 24)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`;
      const r = py(["index", "status", index, file, file], {
        THREED_PROJECT: "passport",
        THREED_REV: "aaa1111",
        THREED_STATUS: i % 2 ? "checked" : "concept",
        THREED_REASON: `${reason}${i}`,
        THREED_AT: at,
      });
      expect(r.status).toBe(0);
    }
    const raw = readFileSync(file, "utf-8");
    const doc = JSON.parse(raw);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16 * 1024 - 1024);
    expect(doc.dropped).toBeGreaterThan(0);
    expect(doc.history.length + doc.dropped).toBe(70);
    expect(doc.history[0].reason).toBe(`${reason}69`);
    expect(doc.current).toEqual(doc.history[0]);
  });
});

describe("revision page banner", () => {
  const inject = (html: string) => {
    const src = join(tmp, "in.html");
    const out = join(tmp, "out.html");
    writeFileSync(src, html);
    rmSync(out, { force: true });
    const r = py(["page", "inject", src, out]);
    return { status: r.status, html: existsSync(out) ? readFileSync(out, "utf-8") : null };
  };

  test("goes before </body>, once, and a rerun reports no change", () => {
    const first = inject("<html><BODY><p>x</p></BODY></html>");
    expect(first.status).toBe(0);
    expect(first.html).toMatch(/3d-status-banner:end -->\n<\/BODY>/);
    expect(inject(first.html as string).status).toBe(3);
  });

  test("replaces an older banner and appends when there is no </body>", () => {
    const old = "<body><!-- 3d-status-banner:start -->old<!-- 3d-status-banner:end --></body>";
    const r = inject(old);
    expect(r.html).not.toContain(">old<");
    expect(r.html?.match(/3d-status-banner:start/g)).toHaveLength(1);
    expect(inject("<p>bare</p>").html).toMatch(/^<p>bare<\/p>\n<!-- 3d-status-banner:start -->/);
  });

  test("renders text only and links only a revision id", () => {
    const { html } = inject("<body></body>");
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("/^[A-Za-z0-9._-]{1,64}$/.test(c.supersededBy)");
  });
});
