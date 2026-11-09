/**
 * Dry-run the publish workflow's versioning against a repo's history.
 *
 * reusable-typescript-publish.yml calls the versioning action twice: once to compute the
 * number (no side effects), then publish writes that number into package.json and ships it,
 * then once more to tag and release. This script runs the bundled action
 * (versioning/dist/index.js) the same way, with dry_run on, in a throwaway clone, and prints
 * the version that would be published and the tag that would be created. They must match.
 *
 *   tsx scripts/versioning-dry-run.ts <repo-dir-or-url> [--ref <rev>] [--tag <name>=<rev>]...
 *       [--tag-prefix <p>] [--legacy]
 *
 * The clone carries no tags except the --tag ones, so a repo's state before a given run can
 * be rebuilt: no flags = the first run on an untagged repo. --legacy runs the record step the
 * way it ran before 2026-11-09 (recomputing instead of being handed the number).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const actionEntry = join(rootDir, "versioning", "dist", "index.js");

export interface DryRunOptions {
  /** Checked-out revision (default HEAD of the source). */
  ref?: string;
  /** Tags present before the run, as name → revision. */
  tags?: Record<string, string>;
  tagPrefix?: string;
  /** Record step recomputes instead of receiving the computed version (the pre-fix behaviour). */
  legacy?: boolean;
}

export interface DryRunResult {
  /** What publish would ship ("" = nothing to release). */
  published: string;
  /** The tag the record step would create. */
  tag: string;
  /** Tag minus prefix; equal to `published` when the two agree. */
  tagged: string;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

/** Parse a GITHUB_OUTPUT file (`name<<delim\nvalue\ndelim` blocks). */
export function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([^<=]+)<<(.+)$/);
    if (!match) continue;
    const [, name, delim] = match;
    const value: string[] = [];
    while (++i < lines.length && lines[i] !== delim) value.push(lines[i]);
    outputs[name] = value.join("\n");
  }
  return outputs;
}

function runAction(cwd: string, inputs: Record<string, string>): Record<string, string> {
  const outFile = join(cwd, "..", `outputs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(outFile, "");
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: outFile };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  const res = spawnSync(process.execPath, [actionEntry], { cwd, env, encoding: "utf8" });
  if (res.status !== 0 || /^::error::/m.test(res.stdout)) {
    throw new Error(`versioning action failed:\n${res.stdout}${res.stderr}`);
  }
  return parseOutputs(readFileSync(outFile, "utf8"));
}

/** Run compute → publish's package.json write → record, as the publish workflow does. */
export function dryRunPublish(source: string, options: DryRunOptions = {}): DryRunResult {
  const tagPrefix = options.tagPrefix ?? "v";
  const work = mkdtempSync(join(tmpdir(), "versioning-dry-run-"));
  const repo = join(work, "repo");
  try {
    git(work, ["clone", "-q", "--no-tags", source, repo]);
    if (options.ref) git(repo, ["checkout", "-q", options.ref]);
    for (const tag of git(repo, ["tag", "-l"]).split("\n").filter(Boolean)) git(repo, ["tag", "-d", tag]);
    for (const [name, rev] of Object.entries(options.tags ?? {})) git(repo, ["tag", name, rev]);

    const common = { dry_run: "true", tag_prefix: tagPrefix, generate_changelog: "false" };
    const computed = runAction(repo, {
      ...common,
      create_tag: "false",
      create_release: "false",
      update_version_file: "false",
    });
    const published = computed.version ?? "";
    if (!published) return { published: "", tag: "", tagged: "" };

    // typescript/publish: "Wrote version X into package.json".
    const pkgPath = join(repo, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.version = published;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const recorded = runAction(repo, {
      ...common,
      create_tag: "true",
      create_release: "true",
      update_version_file: "false",
      ...(options.legacy ? {} : { version: published }),
    });
    const tag = recorded.tag ?? "";
    return { published, tag, tagged: tag.startsWith(tagPrefix) ? tag.slice(tagPrefix.length) : tag };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const [source, ...rest] = argv;
  if (!source) {
    console.error(
      "usage: versioning-dry-run.ts <repo> [--ref <rev>] [--tag <name>=<rev>]... [--tag-prefix <p>] [--legacy]",
    );
    return 2;
  }
  const options: DryRunOptions = { tags: {} };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--ref") options.ref = rest[++i];
    else if (flag === "--tag-prefix") options.tagPrefix = rest[++i];
    else if (flag === "--legacy") options.legacy = true;
    else if (flag === "--tag") {
      const [name, rev] = rest[++i].split("=");
      (options.tags as Record<string, string>)[name] = rev;
    } else {
      console.error(`unknown flag ${flag}`);
      return 2;
    }
  }
  const result = dryRunPublish(resolveSource(source), options);
  console.log(`ref:       ${options.ref ?? "HEAD"}`);
  console.log(`tags:      ${Object.keys(options.tags ?? {}).join(", ") || "(none)"}`);
  console.log(`published: ${result.published || "(nothing to release)"}`);
  console.log(`tag:       ${result.tag || "(none)"}`);
  if (result.published && result.published !== result.tagged) {
    console.log("MISMATCH: the tag does not match the published version");
    return 1;
  }
  return 0;
}

function resolveSource(source: string): string {
  return /^[a-z+]+:\/\/|^git@/.test(source) ? source : resolve(source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
