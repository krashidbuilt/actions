#!/usr/bin/env python3
"""Helpers for scripts/3d-publish.sh: revision briefs, status files and the project index.

    3d-publish.py brief validate FILE...       check briefs, print every error
    3d-publish.py brief build FILE --project P --rev R --at ISO --out brief.json
    3d-publish.py index publish PROJECT_JSON   upsert a published revision (THREED_* env)
    3d-publish.py index brief PROJECT_JSON BRIEF_JSON STATUS_IN STATUS_OUT
                                               attach a brief to a listed revision
    3d-publish.py index status PROJECT_JSON STATUS_IN STATUS_OUT
                                               change a revision's status (THREED_* env)
    3d-publish.py index has-status PROJECT_JSON REV  exit 0 when REV has a status
    3d-publish.py index root SRC_DIR OUT_JSON  rebuild /index.json from every project
    3d-publish.py page inject IN_HTML OUT_HTML add the "superseded by" banner (exit 3: unchanged)

A brief is markdown with a small front matter (see BRIEF FORMAT in 3d-publish.sh), published as
/<project>/<rev>/brief.json + brief.md and fixed with the revision. Its status lives beside it in
/<project>/<rev>/status.json: the current value, dated, with a reason, and the history newest
first (bounded by bytes). Those two files are the source of truth; the index entry carries a
copy of title, summary and current status for sorting. STATUS_OUT is written only on a change.

Standard library only; runs as `python3 -I` on python 3.9+.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys

STATUSES = ("concept", "checked", "recommended", "superseded", "signed-off")
REV_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
REQUIRED_SECTIONS = ("What changed", "Limitations", "Recommendation")
FRONT_KEYS = ("title", "summary", "status", "status_reason", "parent", "superseded_by", "numbers", "links")
LIST_KEYS = ("numbers", "links")
MAX_BYTES = 32 * 1024
MAX_TITLE, MAX_SUMMARY, MAX_REASON = 100, 200, 300
MAX_NUMBERS, MAX_LINKS, MAX_CELL = 12, 10, 60
EXCERPT = 280
ISO_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?$")


class BriefError(Exception):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


# The project-level files the edge serves by name: never a revision id.
RESERVED_REVS = (".", "..", "index.json", "brief.json", "status.json")


def valid_rev(rev: object) -> bool:
    return isinstance(rev, str) and bool(REV_RE.match(rev)) and rev not in RESERVED_REVS


def _scalar(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def split_front_matter(text: str) -> tuple[list[tuple[int, str]], str]:
    """(front-matter lines with their line numbers, body)."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        raise BriefError(["line 1: a brief starts with a front matter block: '---' on the first line"])
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return [(n + 1, lines[n]) for n in range(1, i)], "\n".join(lines[i + 1 :])
    raise BriefError(["the front matter is not closed: no second '---' line"])


def parse_front_matter(lines: list[tuple[int, str]], errors: list[str]) -> dict:
    meta: dict = {}
    current: str | None = None
    for n, line in lines:
        if not line.strip():
            continue
        if line.lstrip().startswith("#"):
            errors.append(f"line {n}: comments are not allowed in the front matter")
            continue
        item = re.match(r"^\s+-\s+(.*)$", line)
        if item:
            if current is None:
                errors.append(f"line {n}: a list item outside 'numbers:' or 'links:'")
                continue
            meta[current].append((n, item.group(1).strip()))
            continue
        kv = re.match(r"^([a-z_]+):(?:\s+(.*))?$", line)
        if not kv:
            errors.append(f"line {n}: expected 'key: value' (got {line.strip()[:40]!r})")
            current = None
            continue
        key, value = kv.group(1), (kv.group(2) or "").strip()
        if key not in FRONT_KEYS:
            errors.append(f"line {n}: unknown key '{key}' (allowed: {', '.join(FRONT_KEYS)})")
            current = None
            continue
        if key in meta:
            errors.append(f"line {n}: '{key}' is given twice")
        if key in LIST_KEYS:
            if value:
                errors.append(f"line {n}: '{key}:' takes '  - label: value' items on the next lines")
            meta[key] = []
            current = key
        else:
            meta[key] = _scalar(value)
            current = None
    return meta


def parse_sections(body: str, errors: list[str]) -> list[dict]:
    """H2 sections in order; text before the first H2 is an untitled section."""
    sections: list[dict] = []
    title, buf = None, []
    for line in body.split("\n"):
        h = re.match(r"^##\s+(.+?)\s*#*\s*$", line)
        if h and not line.startswith("###"):
            if title is not None or "".join(buf).strip():
                sections.append({"title": title, "markdown": "\n".join(buf).strip()})
            title, buf = h.group(1).strip(), []
        else:
            buf.append(line)
    if title is not None or "".join(buf).strip():
        sections.append({"title": title, "markdown": "\n".join(buf).strip()})
    by_name = {}
    for s in sections:
        if s["title"]:
            key = s["title"].lower()
            if key in by_name:
                errors.append(f"section '## {s['title']}' appears twice")
            by_name[key] = s
    for name in REQUIRED_SECTIONS:
        s = by_name.get(name.lower())
        if s is None:
            errors.append(f"missing section '## {name}'")
        elif not s["markdown"]:
            errors.append(f"section '## {name}' is empty")
    return sections


def plain(markdown: str, limit: int = EXCERPT) -> str:
    """Markdown → one line of plain text for the index card's hover (rendered as text, never HTML)."""
    out = []
    for line in markdown.split("\n"):
        line = line.strip()
        if not line or re.match(r"^\|?\s*:?-{3,}", line):
            continue
        line = re.sub(r"^#{1,6}\s+", "", line)
        line = re.sub(r"^([-*+]|\d+[.)])\s+", "• ", line)
        line = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", line)
        line = re.sub(r"(\*\*|__|`)", "", line)
        line = re.sub(r"(?<![\w*])\*(?!\s)([^*]+)\*", r"\1", line)
        out.append(line)
    text = " ".join(out)
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def parse_brief(text: str) -> dict:
    """Parse and validate one brief. Raises BriefError with every problem found."""
    errors: list[str] = []
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise BriefError([f"the brief is over {MAX_BYTES // 1024} KiB"])
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    front, body = split_front_matter(text)
    meta = parse_front_matter(front, errors)

    def need(key: str, limit: int) -> str:
        value = meta.get(key, "")
        if not isinstance(value, str) or not value:
            errors.append(f"'{key}' is required")
            return ""
        if len(value) > limit:
            errors.append(f"'{key}' is {len(value)} characters (at most {limit})")
        return value

    title = need("title", MAX_TITLE)
    summary = need("summary", MAX_SUMMARY)
    status = need("status", 40)
    if status and status not in STATUSES:
        errors.append(f"'status' must be one of {', '.join(STATUSES)} (got '{status}')")
    reason = meta.get("status_reason", "")
    if len(reason) > MAX_REASON:
        errors.append(f"'status_reason' is {len(reason)} characters (at most {MAX_REASON})")
    for key in ("parent", "superseded_by"):
        if key in meta and not valid_rev(meta[key]):
            errors.append(f"'{key}' must be a revision id [A-Za-z0-9._-]{{1,64}} (got '{meta[key]}')")
    superseded_by = meta.get("superseded_by") or None
    if status == "superseded" and not superseded_by:
        errors.append("status 'superseded' needs 'superseded_by: <rev>' (the revision that replaces it)")
    if superseded_by and status != "superseded":
        errors.append("'superseded_by' is only for status 'superseded'")

    numbers = []
    for n, item in meta.get("numbers", []):
        m = re.match(r"^(.+?):\s+(.+)$", _scalar(item))
        if not m:
            errors.append(f"line {n}: a number is '- <label>: <value>'")
            continue
        label, value = m.group(1).strip(), m.group(2).strip()
        if len(label) > MAX_CELL or len(value) > MAX_CELL:
            errors.append(f"line {n}: number label and value are at most {MAX_CELL} characters each")
        numbers.append({"label": label, "value": value})
    if len(numbers) > MAX_NUMBERS:
        errors.append(f"{len(numbers)} numbers (at most {MAX_NUMBERS})")

    links = []
    for n, item in meta.get("links", []):
        m = re.match(r"^(.+?):\s+(https?://\S+)$", _scalar(item))
        if not m:
            errors.append(f"line {n}: a link is '- <label>: <http(s) url>'")
            continue
        label, url = m.group(1).strip(), m.group(2)
        if len(label) > MAX_CELL:
            errors.append(f"line {n}: link label is at most {MAX_CELL} characters")
        if re.search(r"[\s<>\"'`]", url):
            errors.append(f"line {n}: the link URL has characters a URL cannot have")
        links.append({"label": label, "url": url})
    if len(links) > MAX_LINKS:
        errors.append(f"{len(links)} links (at most {MAX_LINKS})")

    sections = parse_sections(body, errors)
    if errors:
        raise BriefError(errors)
    by_name = {s["title"].lower(): s["markdown"] for s in sections if s["title"]}
    return {
        "title": title,
        "summary": summary,
        "status": status,
        "statusReason": reason or None,
        "parent": meta.get("parent") or None,
        "supersededBy": superseded_by,
        "numbers": numbers,
        "links": links,
        "sections": sections,
        "excerpt": {
            "limitations": plain(by_name["limitations"]),
            "recommendation": plain(by_name["recommendation"]),
        },
    }


def build_brief(text: str, project: str, rev: str, at: str) -> dict:
    brief = parse_brief(text)
    return {
        "format": "3d-brief/1",
        "project": project,
        "rev": rev,
        "at": at,
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        **brief,
    }


# ---------------------------------------------------------------------------- status.json

# /<project>/<rev>/status.json is the source of truth for a revision's status; the index entry
# carries a copy of the current value for sorting. History is newest first and bounded by bytes:
# the oldest changes are dropped (and counted) once the file would pass MAX_STATUS_BYTES minus a
# reserve for the next change.
MAX_STATUS_BYTES = 16 * 1024
STATUS_RESERVE = 1024


def load_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def save_json(path: str, doc: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)


def _size(doc: dict) -> int:
    return len(json.dumps(doc, indent=1, ensure_ascii=False).encode("utf-8"))


def status_add(doc: dict, project: str, rev: str, change: dict) -> dict:
    """Return a new status document with `change` as the current status, history newest first."""
    history = [h for h in doc.get("history", []) if isinstance(h, dict)]
    history.append(change)
    history.sort(key=lambda h: str(h.get("at", "")), reverse=True)
    out = {
        "format": "3d-status/1",
        "project": project,
        "rev": rev,
        "current": history[0],
        "history": history,
        "dropped": int(doc.get("dropped", 0) or 0),
    }
    while len(out["history"]) > 1 and _size(out) > MAX_STATUS_BYTES - STATUS_RESERVE:
        out["history"].pop()
        out["dropped"] += 1
    return out


def make_change(value: str, at: str, reason: str, superseded_by: str | None) -> dict:
    change = {"value": value, "at": at, "reason": reason}
    if superseded_by:
        change["supersededBy"] = superseded_by
    return change


# ---------------------------------------------------------------------------- index entries


def revisions(entry: dict) -> list[dict]:
    return [r for r in entry.get("revisions", []) if isinstance(r, dict)]


def find(entry: dict, rev: str) -> dict | None:
    return next((r for r in revisions(entry) if r.get("rev") == rev), None)


def touch(rev: dict, at: str) -> None:
    """`updated` = the latest of publish, re-publish, brief and status changes (never note activity)."""
    rev["updated"] = max(str(rev.get("updated") or ""), str(rev.get("date") or ""), at)


def copy_status(rev: dict, doc: dict) -> None:
    """The index entry's copy of status.json's current value."""
    current = doc.get("current")
    if not isinstance(current, dict):
        return
    rev["status"] = {k: current[k] for k in ("value", "at", "reason", "supersededBy") if k in current}
    rev["statusPath"] = f"/{doc['project']}/{doc['rev']}/status.json"
    if current.get("supersededBy"):
        rev["supersededBy"] = current["supersededBy"]
    else:
        rev.pop("supersededBy", None)
    touch(rev, str(current.get("at", "")))


# Fields a re-publish of the same rev keeps from the old entry (the overlay outlives the files).
KEPT_ON_REPUBLISH = ("brief", "status", "statusPath", "parent", "supersededBy", "renders")


def index_publish(path: str, env: dict) -> dict:
    entry = load_json(path)
    project, rev = env["THREED_PROJECT"], env["THREED_REV"]
    old = find(entry, rev)
    revs = [r for r in revisions(entry) if r.get("rev") != rev]
    thumb = env.get("THREED_THUMB", "")
    new = {
        "rev": rev,
        "date": env["THREED_DATE"],
        "title": env.get("THREED_TITLE") or rev,
        "path": f"/{project}/{rev}/",
        "thumb": f"/{project}/{rev}/renders/{thumb}" if thumb else None,
    }
    if old:
        for key in KEPT_ON_REPUBLISH:
            if key in old:
                new[key] = old[key]
        new["updated"] = old.get("updated") or old.get("date")
        touch(new, env.get("THREED_AT") or env["THREED_DATE"])
    renders = [r for r in env.get("THREED_RENDERS", "").split("\n") if r]
    if renders:
        new["renders"] = renders
    revs.append(new)
    revs.sort(key=lambda r: str(r.get("date", "")), reverse=True)
    entry = {
        "id": project,
        "title": env.get("THREED_PROJECT_TITLE") or entry.get("title") or project,
        "revisions": revs,
    }
    save_json(path, entry)
    return new


def index_brief(path: str, brief: dict, status_in: str, status_out: str, replace: bool, renders: list[str]) -> dict:
    """Attach a brief (built by build_brief) to a revision already in the project index.

    `status_in` is the revision's current status.json (missing = none yet). A first status comes
    from the brief's front matter and is written to `status_out`; an existing status is kept.
    """
    entry = load_json(path)
    project, target = brief["project"], brief["rev"]
    rev = find(entry, target)
    if rev is None:
        raise BriefError([f"revision '{target}' is not in /{project}/index.json; publish it first"])
    old = rev.get("brief") if isinstance(rev.get("brief"), dict) else None
    if old and old.get("sha256") == brief["sha256"]:
        return rev  # the same brief again: nothing changes, not even `updated`
    if old and not replace:
        raise BriefError(
            [f"{target} already has a different brief (sha256 {str(old.get('sha256', '?'))[:12]}); "
             "a brief is fixed with its revision. Change the status with --set-status, or pass "
             "--replace-brief to correct it"]
        )
    if brief["parent"] and (brief["parent"] == target or find(entry, brief["parent"]) is None):
        raise BriefError([f"parent '{brief['parent']}' must be another revision in /{project}/index.json"])
    doc = load_json(status_in)
    by = brief["supersededBy"]
    if not doc.get("current") and by and (by == target or find(entry, by) is None):
        raise BriefError([f"superseded_by '{by}' must be another revision in /{project}/index.json"])
    record = {
        "path": f"/{project}/{target}/brief.json",
        "md": f"/{project}/{target}/brief.md",
        "sha256": brief["sha256"],
        "at": brief["at"],
        "title": brief["title"],
        "summary": brief["summary"],
        "limitations": brief["excerpt"]["limitations"],
        "recommendation": brief["excerpt"]["recommendation"],
    }
    if old:
        record["replaced"] = [*old.get("replaced", []), {"at": brief["at"], "sha256Before": old.get("sha256")}]
    rev["brief"] = record
    if brief["parent"]:
        rev["parent"] = brief["parent"]
    if renders and not rev.get("renders"):
        rev["renders"] = renders
    if not doc.get("current"):
        change = make_change(brief["status"], brief["at"], brief["statusReason"] or "first brief", by)
        doc = status_add({}, project, target, change)
        save_json(status_out, doc)
    copy_status(rev, doc)
    touch(rev, brief["at"])
    save_json(path, entry)
    return rev


def index_status(path: str, status_in: str, status_out: str, env: dict) -> dict:
    entry = load_json(path)
    project, target, value = env["THREED_PROJECT"], env["THREED_REV"], env["THREED_STATUS"]
    reason, at = env.get("THREED_REASON", "").strip(), env["THREED_AT"]
    by = env.get("THREED_SUPERSEDED_BY") or None
    errors = []
    rev = find(entry, target)
    if rev is None:
        errors.append(f"revision '{target}' is not in /{project}/index.json")
    if value not in STATUSES:
        errors.append(f"status must be one of {', '.join(STATUSES)} (got '{value}')")
    if not reason:
        errors.append("--reason is required: say why the status changes")
    elif len(reason) > MAX_REASON:
        errors.append(f"--reason is at most {MAX_REASON} characters")
    if value == "superseded" and not by:
        errors.append("status superseded needs --superseded-by <rev>")
    if by and value != "superseded":
        errors.append("--superseded-by is only for status superseded")
    if by and (by == target or find(entry, by) is None):
        errors.append(f"--superseded-by '{by}' must be another revision in /{project}/index.json")
    if errors:
        raise BriefError(errors)
    doc = load_json(status_in)
    current = doc.get("current") or {}
    change = make_change(value, at, reason, by)
    if all(current.get(k) == change.get(k) for k in ("value", "reason", "supersededBy")):
        return rev  # already so: a rerun changes nothing
    doc = status_add(doc, project, target, change)
    save_json(status_out, doc)
    copy_status(rev, doc)
    save_json(path, entry)
    return rev


def index_root(src: str, out: str) -> list[str]:
    projects = []
    for name in sorted(os.listdir(src)):
        entry = load_json(os.path.join(src, name))
        if entry.get("id") and entry.get("revisions"):
            projects.append(entry)
    projects.sort(key=lambda p: str(p["revisions"][0].get("date", "")), reverse=True)
    save_json(out, {"projects": projects})
    return [p["id"] for p in projects]


# ---------------------------------------------------------------------------- revision page banner

# A revision page reached by its own link shows "Superseded by <rev>" from its own status.json.
# Injected into the published viewer page (cadkit's index.html) between fixed markers, so it is
# idempotent and a newer banner replaces an older one. Text only (textContent), and the link
# target must be a revision id.
BANNER_START, BANNER_END = "<!-- 3d-status-banner:start -->", "<!-- 3d-status-banner:end -->"
BANNER = BANNER_START + """
<script>
(function () {
  var dir = location.pathname.replace(/\\/index\\.html$/, "/").replace(/\\/?$/, "/");
  fetch(dir + "status.json", { credentials: "same-origin", cache: "no-store" })
    .then(function (r) { return r.ok && /json/.test(r.headers.get("content-type") || "") ? r.json() : null; })
    .then(function (s) {
      var c = s && s.current;
      if (!c || c.value !== "superseded") return;
      var by = typeof c.supersededBy === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(c.supersededBy) ? c.supersededBy : null;
      var bar = document.createElement("div");
      bar.setAttribute("role", "status");
      bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:6px 40px 6px 12px;" +
        "background:#7a4b00;color:#fff;font:13px/1.4 system-ui,-apple-system,sans-serif;text-align:center";
      bar.appendChild(document.createTextNode("Superseded" + (by ? " by " : "") ));
      if (by) {
        var a = document.createElement("a");
        a.href = "../" + by + "/";
        a.textContent = by;
        a.style.color = "#fff";
        bar.appendChild(a);
      }
      if (c.reason) bar.appendChild(document.createTextNode(" \\u2014 " + String(c.reason).slice(0, 300)));
      var x = document.createElement("button");
      x.type = "button";
      x.textContent = "\\u00d7";
      x.setAttribute("aria-label", "Dismiss");
      x.style.cssText = "position:absolute;right:8px;top:2px;background:none;border:0;color:#fff;font-size:18px;cursor:pointer";
      x.onclick = function () { bar.remove(); };
      bar.appendChild(x);
      document.body.appendChild(bar);
    })
    .catch(function () {});
})();
</script>
""" + BANNER_END


def inject_banner(html: str) -> str:
    start, end = html.find(BANNER_START), html.find(BANNER_END)
    if start != -1 and end > start:
        rest = html[end + len(BANNER_END):]
        html = html[:start] + (rest[1:] if rest.startswith("\n") else rest)
    at = html.lower().rfind("</body>")
    return html + "\n" + BANNER + "\n" if at == -1 else html[:at] + BANNER + "\n" + html[at:]


# ---------------------------------------------------------------------------- CLI


def _opt(args: list[str], name: str) -> str:
    if name not in args or args.index(name) + 1 >= len(args):
        raise SystemExit(f"3d-publish.py: {name} is required")
    return args[args.index(name) + 1]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    group, cmd, args = argv[0], argv[1], argv[2:]
    env = dict(os.environ)
    try:
        if (group, cmd) == ("brief", "validate"):
            bad = 0
            for path in args:
                try:
                    with open(path, encoding="utf-8") as f:
                        parse_brief(f.read())
                    print(f"ok    {path}")
                except BriefError as e:
                    bad += 1
                    for err in e.errors:
                        print(f"error {path}: {err}")
            return 1 if bad or not args else 0
        if (group, cmd) == ("brief", "build"):
            at = _opt(args, "--at")
            project, rev = _opt(args, "--project"), _opt(args, "--rev")
            if not ISO_RE.match(at):
                raise BriefError([f"--at must be ISO 8601 (got '{at}')"])
            if not valid_rev(rev):
                raise BriefError([f"--rev must be a revision id (got '{rev}')"])
            with open(args[0], encoding="utf-8") as f:
                brief = build_brief(f.read(), project, rev, at)
            save_json(_opt(args, "--out"), brief)
            print(f"brief {rev}: {brief['status']}, {brief['title']}")
            return 0
        if (group, cmd) == ("index", "publish"):
            new = index_publish(args[0], env)
            entry = load_json(args[0])
            latest = entry["revisions"][0]["rev"]
            print(f"{entry['id']}: {len(entry['revisions'])} revision(s), latest {latest} ({new['rev']} upserted)")
            return 0
        if (group, cmd) == ("index", "brief"):
            renders = [r for r in env.get("THREED_RENDERS", "").split("\n") if r]
            rev = index_brief(args[0], load_json(args[1]), args[2], args[3],
                              env.get("THREED_REPLACE_BRIEF") == "1", renders)
            print(f"{rev['rev']}: brief {rev['brief']['sha256'][:12]}, status {rev.get('status', {}).get('value')}")
            return 0
        if (group, cmd) == ("index", "status"):
            rev = index_status(args[0], args[1], args[2], env)
            print(f"{rev['rev']}: status {rev['status']['value']}")
            return 0
        if (group, cmd) == ("index", "has-status"):
            rev = find(load_json(args[0]), args[1])
            return 0 if rev and rev.get("status") else 1
        if (group, cmd) == ("index", "root"):
            print("index:", ", ".join(index_root(args[0], args[1])))
            return 0
        if (group, cmd) == ("page", "inject"):
            with open(args[0], encoding="utf-8") as f:
                html = f.read()
            out = inject_banner(html)
            if out == html:
                return 3  # already current: nothing to upload
            with open(args[1], "w", encoding="utf-8") as f:
                f.write(out)
            return 0
    except BriefError as e:
        for err in e.errors:
            print(f"3d-publish: {err}", file=sys.stderr)
        return 2
    print(f"3d-publish.py: unknown command {group} {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
