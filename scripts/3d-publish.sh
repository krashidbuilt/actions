#!/usr/bin/env bash
#
# Publish one CAD project revision to https://3d.krashidbuilt.com, attach its brief, change
# its status, add the review-notes loader to a live revision page, or strip tool naming from its
# <head>.
#
#   scripts/3d-publish.sh --project passport --project-title "Passport enclosure" \
#     --rev "$(git rev-parse --short HEAD)" --title "Passport enclosure v0 (454261 cell)" \
#     --dir cad/enclosure/out/viewer --renders cad/enclosure/renders [--thumb face_on.png] \
#     [--brief cad/enclosure/briefs/<rev>.md]
#   scripts/3d-publish.sh --project passport --rev <rev> --brief <file.md> [--at ISO]
#   scripts/3d-publish.sh --project passport --set-status <rev> superseded --superseded-by <rev2> \
#     --reason "replaced by the controls v3 set" [--at ISO]
#   scripts/3d-publish.sh --project passport --add-loader <rev> [--dry-run]
#   scripts/3d-publish.sh --project passport --strip-head-meta <rev> [--dry-run]
#
#   --project ID          /<project>/ folder: [a-z0-9][a-z0-9-]{0,62}
#   --project-title TEXT  the project's name on the index (default: kept, else the id)
#   --rev REV             the revision folder, usually the short commit sha: [A-Za-z0-9._-]{1,64}
#   --title TEXT          this revision's title (default: the rev)
#   --dir DIR             `cadkit viewer --sidecar` output (index.html + <part>.json)
#   --renders DIR         optional PNGs, uploaded to /<project>/<rev>/renders/
#   --thumb FILE          the render used as the index thumbnail (default face_on.png, iso.png,
#                         else the first PNG)
#   --date ISO8601        the revision date (default now, UTC); orders revisions, newest first
#   --brief FILE.md       the revision's brief, published as /<project>/<rev>/brief.json + brief.md.
#                         With --dir it ships with the publish; without, it is attached to a rev
#                         already in the index. Fixed with the revision: a different brief for the
#                         same rev is refused unless --replace-brief (a correction, kept on record)
#   --set-status REV S    change REV's status (concept|checked|recommended|superseded|signed-off)
#                         without a new revision; needs --reason, and --superseded-by for
#                         superseded. Kept in /<project>/<rev>/status.json (history newest
#                         first); the revision page shows "Superseded by <rev>" from it
#   --add-loader REV      add the review-notes bootstrap (the block cadkit's viewer.html carries)
#                         before </head> of REV's live index.html and nothing else: read with its
#                         ETag, VersionId and headers, put back with --if-match and the same
#                         headers (exit 2 if the page changed in between), then invalidate
#                         /<project>/<rev>/ and its index.html. Already there = write nothing,
#                         invalidate only (an interrupted run is rerun). Prints the diff and the
#                         previous VersionId: rollback = copy that version back + invalidate
#   --strip-head-meta REV delete the two head lines older cadkit pages carry (the
#                         claude:viewport-fit-sides hint and the generator meta) from REV's live
#                         index.html and nothing else; the same read, conditional put, invalidation
#                         and rollback as --add-loader. Neither line there = write nothing. Any
#                         other difference, or a variant of either meta, is refused (exit 2)
#   --at ISO8601          when the brief or status change happened (default now; with --dir, the
#                         --date). Orders the "last updated" view
#   --bucket NAME         default: SSM /platform/3d/bucket
#   --distribution-id ID  default: SSM /platform/3d/distribution-id
#   --dry-run             print what would happen, change nothing
#   --validate-brief F... check briefs and exit (needs only python3)
#
# BRIEF FORMAT (checked before any upload, and by --validate-brief): front matter between
# '---' lines with title (<= 100), summary (one line, <= 200), status, and optionally
# status_reason, parent and superseded_by (revision ids), numbers ('  - <label>: <value>', <= 12)
# and links ('  - <label>: <http(s) url>' or '  - <label>: /<project>/<rev>/', <= 10); then
# markdown with the H2 sections '## What changed', '## Limitations' and '## Recommendation'
# (others allowed). <= 32 KiB. Clients read briefs on white-label hosts that serve the same paths,
# so a brief never shows a krashidbuilt.com address: a page of the 3D site is linked by its path
# (/<project>/<rev>/, also as a markdown link target), never as https://3d.krashidbuilt.com/...;
# a krashidbuilt.com host in visible text (a bare URL, a link label, a title) is refused, and so is
# a link to any krashidbuilt.com host but git.dsm.krashidbuilt.com (the viewer hides that one from
# clients).
#
# A revision is immutable: a new sha is a new folder, and publishing a rev that is already in
# the index is refused. A brief or status change writes only brief.json, brief.md, status.json
# and the indexes, never the folder (the folder sync never touches those three files either).
# Revision files get a long cache; index.json, brief and status files are no-cache.
# /<project>/index.json is that project's entry and /index.json is rebuilt from every project's
# index.json, so a lost race on the root heals on the next publish. /<project>/index.json is read
# fail-closed (absent = a new project). Needs the aws CLI (AWS_PROFILE, or the 3d-publisher keys
# in the environment) and python3.

set -euo pipefail

# The python helper ships inside this file, so a single copy of the script still runs (the
# passport README copies it to /tmp with `git show`). It is written to a temp dir per run.
write_helper() {
	cat >"$1" <<'PY'
#!/usr/bin/env python3
"""Helpers for scripts/3d-publish.sh: revision briefs, status files and the project index.

    3d-publish.py brief validate FILE...       check briefs, print every error
    3d-publish.py brief build FILE --project P --rev R --at ISO --out brief.json
    3d-publish.py index publish PROJECT_JSON   add a new revision (THREED_* env); refuses a listed one
    3d-publish.py index brief PROJECT_JSON BRIEF_JSON STATUS_IN STATUS_OUT
                                               attach a brief to a listed revision
    3d-publish.py index status PROJECT_JSON STATUS_IN STATUS_OUT
                                               change a revision's status (THREED_* env)
    3d-publish.py index root SRC_DIR OUT_JSON  rebuild /index.json from every project
    3d-publish.py page inject IN_HTML OUT_HTML add the status banner (exit 3: unchanged)
    3d-publish.py page loader IN_HTML OUT_HTML add the review-notes bootstrap before </head> and
                                               print the diff (exit 3: already there, 2: refused)
    3d-publish.py page strip-meta IN_HTML OUT_HTML
                                               delete STRIP_LINES from <head> and print the diff
                                               (exit 3: neither there, 2: refused)
    3d-publish.py object fields RESP_JSON META_JSON
                                               ETag, VersionId, Cache-Control, Content-Type of a
                                               get-object response (\x1f separated); user metadata
                                               to META_JSON

Embedded in 3d-publish.sh (write_helper) so one copy of the script is enough.

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
from urllib.parse import urlsplit

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

# Briefs are shown on the staff host and on white-label client hosts that serve the same
# /<project>/<rev>/ paths, so a brief never shows a krashidbuilt.com address and links a page of
# the site by its path. A same-site path is the viewer's safePath rule (site-content/3d/index.html
# in krashidbuilt/infrastructure), kept in step with it:
#   /^\/[A-Za-z0-9._~/-]*$/.test(p) && !p.includes("..") && !p.includes("//")
SAFE_PATH_RE = re.compile(r"^/[A-Za-z0-9._~/-]*$")
# The 3D review site's staff host. The bucket is named after it (SSM /platform/3d/bucket), but a
# brief is checked before the bucket is known (--validate-brief needs only python3).
REVIEW_HOSTS = ("3d.krashidbuilt.com",)
# The viewer's STAFF_ONLY_HOSTS: it drops links to these for clients, so they may be link targets.
STAFF_ONLY_HOSTS = ("git.dsm.krashidbuilt.com",)
INTERNAL_HOST_RE = re.compile(r"(?<![A-Za-z0-9-])(?:[A-Za-z0-9-]+\.)*krashidbuilt\.com(?![A-Za-z0-9-])", re.I)
# The viewer's inline markdown (INLINE): a code span shows its text, a link its label only.
MD_INLINE_RE = re.compile(r"(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))")
FENCE_RE = re.compile(r"^\s*```")


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


def safe_path(p: str) -> bool:
    return bool(SAFE_PATH_RE.match(p)) and ".." not in p and "//" not in p


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _as_path(url: str) -> str:
    """The same page as a same-site path, for the error message."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "/<project>/<rev>/"
    path = parts.path or "/"
    return path + (f"#{parts.fragment}" if parts.fragment else "") if safe_path(path) else "/<project>/<rev>/"


def check_href(where: str, url: str, errors: list[str]) -> None:
    """A link the viewer shows to clients: no 3D review host, no other krashidbuilt.com host
    (a staff-only host is fine: the viewer drops it for clients)."""
    host = _host(url)
    if host in REVIEW_HOSTS:
        errors.append(
            f"{where}: {url} is on the staff host {host}, which clients must never see;"
            f" link the page by its path instead: {_as_path(url)} (/<project>/<rev>/ works on every host)"
        )
    elif host not in STAFF_ONLY_HOSTS and INTERNAL_HOST_RE.fullmatch(host):
        errors.append(
            f"{where}: {url} shows the internal host {host} to clients (only links to"
            f" {', '.join(STAFF_ONLY_HOSTS)} are hidden from them); link a 3D page by its path: /<project>/<rev>/"
        )


def check_visible(where: str, text: str, errors: list[str]) -> None:
    """Text a client reads (not a link target) never names a krashidbuilt.com host."""
    m = INTERNAL_HOST_RE.search(text)
    if m:
        errors.append(
            f"{where}: '{m.group(0)}' is visible text, and clients must never see a krashidbuilt.com address;"
            " link a 3D page by its path, e.g. [label](/<project>/<rev>/), or drop the address"
        )


def check_body(body: str, first_line: int, errors: list[str]) -> None:
    """Every visible line of the markdown body, and every link target, as the viewer renders it:
    code spans and fenced blocks show their text, a link shows its label and is checked as a link."""
    fenced = False
    for i, line in enumerate(body.split("\n")):
        where = f"line {first_line + i}"
        if FENCE_RE.match(line):
            fenced = not fenced
            continue
        if fenced:
            check_visible(where, line, errors)
            continue
        targets: list[str] = []

        def visible(m: re.Match) -> str:
            if m.group(1):
                return m.group(2)
            targets.append(m.group(5))
            return m.group(4)

        check_visible(where, MD_INLINE_RE.sub(visible, line), errors)
        for url in targets:
            check_href(f"{where}: link target", url, errors)


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
        check_visible(f"line {n}", f"{label} {value}", errors)
        numbers.append({"label": label, "value": value})
    if len(numbers) > MAX_NUMBERS:
        errors.append(f"{len(numbers)} numbers (at most {MAX_NUMBERS})")

    links = []
    for n, item in meta.get("links", []):
        m = re.match(r"^(.+?):\s+(https?://\S+|/\S*)$", _scalar(item))
        if not m:
            errors.append(f"line {n}: a link is '- <label>: <http(s) url or /<project>/<rev>/ path>'")
            continue
        label, url = m.group(1).strip(), m.group(2)
        if len(label) > MAX_CELL:
            errors.append(f"line {n}: link label is at most {MAX_CELL} characters")
        if url.startswith("/"):
            if not safe_path(url):
                errors.append(
                    f"line {n}: a link path is a same-site path like /<project>/<rev>/: letters, digits,"
                    f" . _ ~ - and /, no '..' and no '//' (got '{url}')"
                )
        elif re.search(r"[\s<>\"'`]", url):
            errors.append(f"line {n}: the link URL has characters a URL cannot have")
        else:
            check_href(f"line {n}", url, errors)
        check_visible(f"line {n}: link label", label, errors)
        links.append({"label": label, "url": url})
    if len(links) > MAX_LINKS:
        errors.append(f"{len(links)} links (at most {MAX_LINKS})")

    for key in ("title", "summary", "status_reason"):
        check_visible(f"'{key}'", str(meta.get(key, "")), errors)
    check_body(body, len(text.split("\n")) - len(body.split("\n")) + 1, errors)
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


def make_change(value: str, at: str, reason: str, superseded_by: str | None, run: str = "") -> dict:
    change = {"value": value, "at": at, "reason": reason}
    if superseded_by:
        change["supersededBy"] = superseded_by
    if run:
        change["run"] = run  # which publisher run wrote it (CI run id, else time + pid)
    return change


# ---------------------------------------------------------------------------- index entries


def revisions(entry: dict) -> list[dict]:
    return [r for r in entry.get("revisions", []) if isinstance(r, dict)]


def find(entry: dict, rev: str) -> dict | None:
    return next((r for r in revisions(entry) if r.get("rev") == rev), None)


def touch(rev: dict, at: str) -> None:
    """`updated` = the latest of publish, brief and status changes (never reskins or notes)."""
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


REPUBLISH_REFUSED = (
    "{rev} is already published: a revision is immutable. Attach or correct its brief with "
    "--brief, change its status with --set-status, or publish the new files under a new --rev"
)


def index_publish(path: str, env: dict) -> dict:
    entry = load_json(path)
    project, rev = env["THREED_PROJECT"], env["THREED_REV"]
    if find(entry, rev) is not None:
        raise BriefError([REPUBLISH_REFUSED.format(rev=rev)])
    revs = revisions(entry)
    thumb = env.get("THREED_THUMB", "")
    new = {
        "rev": rev,
        "date": env["THREED_DATE"],
        "title": env.get("THREED_TITLE") or rev,
        "path": f"/{project}/{rev}/",
        "thumb": f"/{project}/{rev}/renders/{thumb}" if thumb else None,
    }
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
        change = make_change(brief["status"], brief["at"], brief["statusReason"] or "first brief", by,
                             os.environ.get("THREED_RUN", ""))
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
    change = make_change(value, at, reason, by, env.get("THREED_RUN", ""))
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


# ---------------------------------------------------------------------------- review-notes loader

# The guarded bootstrap that loads the review-notes UI on a live revision page: only over https
# at /<project>/<rev>/ does it append <script src="/_review/notes/v1/loader.js" defer>; file://
# previews and every other path make no request. Byte-identical to the block cadkit's viewer.html
# carries (krashidbuilt/cadkit, tests/test_viewer.py REVIEW_LOADER_BLOCK), so a page built by a
# newer cadkit already has it. This is the only copy in this script.
LOADER_BLOCK = (
    '<script id="cadkit-review-loader">(function(){if(location.protocol==="https:"&&'
    r'/^\/[a-z0-9-]+\/[A-Za-z0-9._-]+\/$/.test(location.pathname))'
    '{var s=document.createElement("script");s.src="/_review/notes/v1/loader.js";'
    's.defer=true;document.head.appendChild(s);}})();</script>'
)
LOADER_MARKERS = ('id="cadkit-review-loader"', "/_review/notes/v1/loader.js")


class LoaderError(Exception):
    pass


def inject_loader(html: str) -> str | None:
    """The page with LOADER_BLOCK on its own line before </head>; None when it is already there.
    Refuses a page with a different loader (edited by hand or an older block) or no </head>."""
    if LOADER_BLOCK in html:
        return None
    if any(m in html for m in LOADER_MARKERS):
        raise LoaderError("the page has a different review-notes loader; not touching it")
    at = html.lower().find("</head>")
    if at == -1:
        raise LoaderError("the page has no </head>")
    return html[:at] + LOADER_BLOCK + "\n" + html[at:]


def loader_diff(old: str, new: str, name: str) -> str:
    import difflib

    return "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                                        f"live/{name}", f"new/{name}", n=1))


# ---------------------------------------------------------------------------- head meta strip

# The two <head> lines cadkit's viewer.html carried before krashidbuilt/cadkit#10: a viewport hint
# for another host's viewer and a generator meta naming the tool. Revision pages are served on
# white-label client hosts, so --strip-head-meta deletes exactly these lines and nothing else.
STRIP_LINES = (
    '<meta name="claude:viewport-fit-sides" content="cover">',
    '<meta name="generator" content="cadkit viewer">',
)
STRIP_MARKERS = ("claude:", 'name="generator"')


def strip_head_meta(html: str) -> str | None:
    """The page without STRIP_LINES in its <head>; None when neither is there. Refuses a page with
    no </head> or a variant of either meta (another content, two on one line) left after the strip."""
    at = html.lower().find("</head>")
    if at == -1:
        raise LoaderError("the page has no </head>")
    head = html[:at].splitlines(True)
    # The last line may run into </head> (no newline): it is kept whole, never stripped.
    kept = [ln for ln in head if not (ln.endswith("\n") and ln.rstrip("\r\n") in STRIP_LINES)]
    if any(m in ln for ln in kept for m in STRIP_MARKERS):
        raise LoaderError("the head has a claude: or generator meta this mode does not know; not touching it")
    if len(kept) == len(head):
        return None
    out = "".join(kept) + html[at:]
    check_only_stripped(html, out)
    return out


def check_only_stripped(old: str, new: str) -> None:
    """Refuse unless NEW is OLD with whole STRIP_LINES lines deleted and every other byte equal:
    every opcode is an equal run (byte-equal lines) or a delete of STRIP_LINES lines only."""
    import difflib

    a, b = old.splitlines(True), new.splitlines(True)
    for op, i1, i2, _j1, _j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        if op != "delete" or any(ln.rstrip("\r\n") not in STRIP_LINES for ln in a[i1:i2]):
            raise LoaderError("the stripped page differs by more than the two meta lines; refusing")


def object_fields(resp_path: str, meta_path: str) -> str:
    resp = load_json(resp_path)
    save_json(meta_path, resp.get("Metadata") or {})
    fields = [resp.get(k) or "" for k in ("ETag", "VersionId", "CacheControl", "ContentType")]
    if any("\x1f" in f or "\n" in f for f in fields):
        raise LoaderError("unexpected control character in the object's headers")
    return "\x1f".join(fields)  # not whitespace: bash `read` keeps an empty field


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
        if (group, cmd) == ("index", "root"):
            print("index:", ", ".join(index_root(args[0], args[1])))
            return 0
        if (group, cmd) == ("page", "loader"):
            with open(args[0], encoding="utf-8", newline="") as f:
                html = f.read()
            out = inject_loader(html)
            if out is None:
                return 3  # already there: nothing to upload
            with open(args[1], "w", encoding="utf-8", newline="") as f:
                f.write(out)
            sys.stdout.write(loader_diff(html, out, args[2] if len(args) > 2 else "index.html"))
            return 0
        if (group, cmd) == ("page", "strip-meta"):
            with open(args[0], encoding="utf-8", newline="") as f:
                html = f.read()
            out = strip_head_meta(html)
            if out is None:
                return 3  # neither line there: nothing to upload
            with open(args[1], "w", encoding="utf-8", newline="") as f:
                f.write(out)
            sys.stdout.write(loader_diff(html, out, args[2] if len(args) > 2 else "index.html"))
            return 0
        if (group, cmd) == ("object", "fields"):
            print(object_fields(args[0], args[1]))
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
    except LoaderError as e:
        print(f"3d-publish: {e}", file=sys.stderr)
        return 2
    print(f"3d-publish.py: unknown command {group} {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
PY
}

usage() {
	sed -n '2,66p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
helper="$work/3d-publish.py"
write_helper "$helper"

# --validate-brief FILE...: check briefs (CI, pre-commit); needs nothing but python3.
if [[ "${1:-}" == "--validate-brief" ]]; then
	shift
	python3 -I "$helper" brief validate "$@"
	exit $?
fi

project="" project_title="" rev="" title="" dir="" renders="" thumb="" date="" bucket="" dist="" dry=0
brief="" replace_brief=0 loader_rev="" strip_rev="" status_rev="" status="" reason="" superseded_by="" at=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--project) project="${2:-}"; shift 2 ;;
		--project-title) project_title="${2:-}"; shift 2 ;;
		--rev) rev="${2:-}"; shift 2 ;;
		--title) title="${2:-}"; shift 2 ;;
		--dir) dir="${2:-}"; shift 2 ;;
		--renders) renders="${2:-}"; shift 2 ;;
		--thumb) thumb="${2:-}"; shift 2 ;;
		--date) date="${2:-}"; shift 2 ;;
		--brief) brief="${2:-}"; shift 2 ;;
		--replace-brief) replace_brief=1; shift ;;
		--add-loader) loader_rev="${2:-}"; shift 2 ;;
		--strip-head-meta) strip_rev="${2:-}"; shift 2 ;;
		--set-status) status_rev="${2:-}"; status="${3:-}"; shift 3 || shift $# ;;
		--reason) reason="${2:-}"; shift 2 ;;
		--superseded-by) superseded_by="${2:-}"; shift 2 ;;
		--at) at="${2:-}"; shift 2 ;;
		--bucket) bucket="${2:-}"; shift 2 ;;
		--distribution-id) dist="${2:-}"; shift 2 ;;
		--dry-run) dry=1; shift ;;
		-h | --help) usage ;;
		*) echo "3d-publish: unknown argument $1" >&2; usage ;;
	esac
done

die() { echo "3d-publish: $*" >&2; exit 2; }
# index.json, brief.json and status.json are the project-level files the edge serves by name, so
# none of them can ever be a revision folder.
rev_ok() {
	[[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ && "$1" != "." && "$1" != ".." ]] || return 1
	case "$1" in index.json | brief.json | status.json) return 1 ;; esac
}
iso_ok() { [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?$ ]]; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --add-loader and --strip-head-meta edit only the live revision page: one helper command each.
page_flag="" page_rev="" page_cmd=""
[[ -z "$loader_rev" ]] || { page_flag=--add-loader page_rev="$loader_rev" page_cmd=loader; }
if [[ -n "$strip_rev" ]]; then
	[[ -z "$page_flag" ]] || die "--add-loader and --strip-head-meta are separate runs"
	page_flag=--strip-head-meta page_rev="$strip_rev" page_cmd=strip-meta
fi
if [[ -n "$page_flag" ]]; then
	mode=page
	[[ -z "$dir$brief$renders$thumb$title$date$status_rev$reason$superseded_by$at$project_title" && $replace_brief -eq 0 ]] ||
		die "${page_flag} changes only the revision page; run it on its own"
	rev_ok "$page_rev" || die "${page_flag} takes a revision id (got '${page_rev}')"
	[[ -z "$rev" || "$rev" == "$page_rev" ]] || die "--rev and ${page_flag} name different revisions"
	rev="$page_rev"
elif [[ -n "$status_rev" ]]; then
	mode=status
	[[ -z "$dir$brief$renders$thumb$title$date" ]] || die "--set-status changes only the status; run it on its own"
	rev_ok "$status_rev" || die "--set-status takes a revision id (got '${status_rev}')"
	[[ -z "$rev" || "$rev" == "$status_rev" ]] || die "--rev and --set-status name different revisions"
	rev="$status_rev"
	[[ -n "$reason" ]] || die "--set-status needs --reason: say why the status changes"
elif [[ -n "$dir" ]]; then
	mode=publish
else
	mode=brief
	[[ -n "$brief" ]] || die "nothing to do: give --dir (publish), --brief (attach a brief), --set-status, --add-loader or --strip-head-meta"
	[[ -z "$renders$thumb$title$date" ]] || die "--renders/--thumb/--title/--date need --dir (a publish)"
fi
[[ "$mode" == status || -z "$reason$superseded_by" ]] || die "--reason and --superseded-by go with --set-status"
[[ "$project" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "--project must match [a-z0-9][a-z0-9-]{0,62} (got '${project}')"
rev_ok "$rev" || die "--rev must match [A-Za-z0-9._-]{1,64} and not be index.json, brief.json or status.json (got '${rev}')"
[[ -z "$superseded_by" ]] || rev_ok "$superseded_by" || die "--superseded-by takes a revision id (got '${superseded_by}')"
if [[ "$mode" == publish ]]; then
	[[ -f "$dir/index.html" ]] || die "--dir must be a cadkit viewer --sidecar directory with index.html (got '${dir}')"
	[[ -z "$renders" || -d "$renders" ]] || die "--renders is not a directory: ${renders}"
	[[ -z "$thumb" || "$thumb" =~ ^[A-Za-z0-9._-]+\.png$ ]] || die "--thumb is a PNG file name inside --renders"
	[[ -n "$date" ]] || date="$(now)"
	iso_ok "$date" || die "--date must be ISO 8601 (got '${date}')"
	[[ -n "$at" ]] || at="$date"
fi
[[ -n "$at" ]] || at="$(now)"
iso_ok "$at" || die "--at must be ISO 8601 (got '${at}')"
[[ -z "$brief" || -f "$brief" ]] || die "--brief is not a file: ${brief}"
command -v aws >/dev/null || die "the aws CLI is not on PATH"
command -v python3 >/dev/null || die "python3 is not on PATH"

# The brief is checked before anything is uploaded.
if [[ -n "$brief" ]]; then
	python3 -I "$helper" brief build "$brief" --project "$project" --rev "$rev" --at "$at" --out "$work/brief.json"
fi

ssm() { aws ssm get-parameter --name "$1" --query Parameter.Value --output text; }
[[ -n "$bucket" ]] || bucket="$(ssm /platform/3d/bucket)"
[[ -n "$dist" ]] || dist="$(ssm /platform/3d/distribution-id)"
[[ "$bucket" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "bad bucket name '${bucket}'"
[[ "$dist" =~ ^[A-Z0-9]{8,20}$ ]] || die "bad distribution id '${dist}'"

if [[ -n "$renders" && -z "$thumb" ]]; then
	for candidate in face_on.png iso.png; do
		[[ -f "$renders/$candidate" ]] && { thumb="$candidate"; break; }
	done
	if [[ -z "$thumb" ]]; then
		first="$(find "$renders" -maxdepth 1 -name '*.png' -print | LC_ALL=C sort | head -1)"
		[[ -n "$first" ]] && thumb="$(basename "$first")"
	fi
fi
[[ -z "$thumb" || -f "$renders/$thumb" ]] || die "--thumb ${thumb} is not in ${renders}"

prefix="${project}/${rev}"
THREED_RUN="${GITHUB_RUN_ID:+gh-${GITHUB_RUN_ID}-}$(date -u +%Y%m%dT%H%M%SZ)-$$"
export THREED_RUN
written=() # object keys this run wrote, for an invalidation of exactly those (metadata runs)
base="s3://${bucket}"
long="public, max-age=31536000, immutable"
run() {
	if [[ $dry -eq 1 ]]; then printf 'dry-run:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
# Read an object that may not exist yet: 0 = read, 1 = absent, any other error stops the run.
read_optional() {
	if aws s3 cp "${base}/$1" "$2" --only-show-errors 2>"$work/read.err"; then return 0; fi
	grep -qE '\(404\)|NoSuchKey|does not exist|Not Found' "$work/read.err" && return 1
	die "cannot read ${base}/$1: $(cat "$work/read.err")"
}

# --add-loader / --strip-head-meta: the revision page, and nothing else. One get-object gives the
# body and the ETag, VersionId and headers of that same version; the put is conditional on that ETag.
if [[ "$mode" == page ]]; then
	key="${prefix}/index.html"
	if ! aws s3api get-object --bucket "$bucket" --key "$key" "$work/live.html" >"$work/live.json" 2>"$work/read.err"; then
		grep -qE '\(404\)|NoSuchKey|does not exist|Not Found' "$work/read.err" &&
			die "s3://${bucket}/${key} does not exist; publish the revision first"
		die "cannot read s3://${bucket}/${key}: $(cat "$work/read.err")"
	fi
	IFS=$'\x1f' read -r etag version cache_control content_type < <(python3 -I "$helper" object fields "$work/live.json" "$work/live.meta.json") ||
		die "cannot read the headers of s3://${bucket}/${key}"
	[[ -n "$etag" ]] || die "s3://${bucket}/${key} came back without an ETag"
	[[ -n "$version" && "$version" != "null" ]] ||
		die "s3://${bucket}/${key} has no VersionId (bucket versioning off?): no rollback handle, refusing"
	loader_paths=("/${prefix}/" "/${prefix}/index.html")
	rc=0
	python3 -I "$helper" page "$page_cmd" "$work/live.html" "$work/page.html" "$key" || rc=$?
	if [[ $rc -eq 3 && "$page_cmd" == loader ]]; then
		echo "the loader is already on s3://${bucket}/${key} (VersionId ${version}): nothing written, invalidating only"
	elif [[ $rc -eq 3 ]]; then
		echo "neither meta line is on s3://${bucket}/${key} (VersionId ${version}): nothing written, invalidating only"
	elif [[ $rc -eq 0 ]]; then
		put=(aws s3api put-object --bucket "$bucket" --key "$key" --body "$work/page.html" --if-match "$etag"
			--cache-control "${cache_control:-no-cache}" --content-type "${content_type:-text/html; charset=utf-8}")
		[[ "$(cat "$work/live.meta.json")" == "{}" ]] || put+=(--metadata "file://$work/live.meta.json")
		if ! run "${put[@]}" --query VersionId --output text >"$work/put.out" 2>"$work/put.err"; then
			grep -qE 'PreconditionFailed|\(412\)|ConditionalRequestConflict|\(409\)' "$work/put.err" &&
				die "s3://${bucket}/${key} changed since it was read (ETag ${etag}); nothing written, rerun"
			die "cannot write s3://${bucket}/${key}: $(cat "$work/put.err")"
		fi
		cat "$work/put.out"
		echo "previous VersionId: ${version}"
		echo "rollback: aws s3api copy-object --bucket ${bucket} --key ${key} --copy-source '${bucket}/${key}?versionId=${version}' --metadata-directive COPY && aws cloudfront create-invalidation --distribution-id ${dist} --paths ${loader_paths[*]}"
	else
		exit 2
	fi
	run aws cloudfront create-invalidation --distribution-id "$dist" --paths "${loader_paths[@]}" \
		--query Invalidation.Id --output text
	echo "https://${bucket}/${prefix}/"
	exit 0
fi

# The renders' file names, thumbnail first, for the index page's carousel.
render_names=""
if [[ -n "$renders" ]]; then
	render_names="$( { [[ -n "$thumb" ]] && echo "$thumb"; find "$renders" -maxdepth 1 -name '*.png' -exec basename {} \; | LC_ALL=C sort | grep -vxF "${thumb:-/}"; } || true)"
fi

# The project's own index, read fail-closed: absent = a new project (a publish only); any other
# error stops the run before anything is written.
read_optional "${project}/index.json" "$work/project.json" || {
	[[ "$mode" == publish ]] || die "${base}/${project}/index.json does not exist; publish the revision first"
	echo '{}' >"$work/project.json"
}

# Everything is checked against the index before the first write: a publish of a listed rev is
# refused (a revision is immutable), a brief or status change needs the rev to be listed.
status_in="$work/status.json" status_out="$work/status.new.json"
case "$mode" in
	publish)
		THREED_PROJECT="$project" THREED_PROJECT_TITLE="$project_title" THREED_REV="$rev" THREED_TITLE="$title" \
			THREED_DATE="$date" THREED_THUMB="$thumb" THREED_RENDERS="$render_names" \
			python3 -I "$helper" index publish "$work/project.json" || exit 2
		;;
	brief)
		read_optional "${prefix}/status.json" "$status_in" || :
		# Renders already on the bucket, for an older revision whose entry does not list them.
		render_names="$(aws s3api list-objects-v2 --bucket "$bucket" --prefix "${prefix}/renders/" \
			--query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n' | grep -E '\.png$' | sed 's#.*/##' || true)"
		;;
	status)
		read_optional "${prefix}/status.json" "$status_in" || :
		THREED_PROJECT="$project" THREED_REV="$rev" THREED_STATUS="$status" THREED_REASON="$reason" \
			THREED_SUPERSEDED_BY="$superseded_by" THREED_AT="$at" \
			python3 -I "$helper" index status "$work/project.json" "$status_in" "$status_out" || exit 2
		;;
esac
if [[ -n "$brief" ]]; then
	THREED_RENDERS="$render_names" THREED_REPLACE_BRIEF="$replace_brief" \
		python3 -I "$helper" index brief "$work/project.json" "$work/brief.json" "$status_in" "$status_out" || exit 2
fi

if [[ "$mode" == publish ]]; then
	echo "publishing ${dir} -> https://${bucket}/${prefix}/"
	# The page carries a one-line status banner that reads its own status.json at view time (inert
	# until the revision has one), so a single-revision link shows "Superseded by <rev>".
	rc=0
	python3 -I "$helper" page inject "$dir/index.html" "$work/page.html" || rc=$?
	[[ $rc -eq 0 ]] || cp "$dir/index.html" "$work/page.html"
	[[ $rc -eq 0 || $rc -eq 3 ]] || die "could not add the status banner to ${dir}/index.html"
	# Everything but the pages with a long cache, then the pages no-cache (CloudFront serves *.html
	# no-store anyway). brief.json, brief.md and status.json are never synced or deleted.
	run aws s3 sync "$dir" "${base}/${prefix}/" --delete --exclude "renders/*" --exclude "*.html" \
		--exclude "brief.json" --exclude "brief.md" --exclude "status.json" \
		--cache-control "$long" --only-show-errors
	run aws s3 sync "$dir" "${base}/${prefix}/" --exclude "*" --include "*.html" --exclude "index.html" \
		--cache-control "no-cache" --content-type "text/html; charset=utf-8" --only-show-errors
	run aws s3 cp "$work/page.html" "${base}/${prefix}/index.html" \
		--cache-control "no-cache" --content-type "text/html; charset=utf-8" --only-show-errors
	if [[ -n "$renders" ]]; then
		run aws s3 sync "$renders" "${base}/${prefix}/renders/" --delete --exclude "*" --include "*.png" \
			--cache-control "$long" --only-show-errors
	fi
fi
# A brief or status change writes only these three files and the indexes, all no-cache (a
# browser must not keep "checked" after "superseded"), and never deletes anything.
if [[ -n "$brief" ]]; then
	run aws s3 cp "$work/brief.json" "${base}/${prefix}/brief.json" \
		--cache-control "no-cache" --content-type "application/json" --only-show-errors
	run aws s3 cp "$brief" "${base}/${prefix}/brief.md" \
		--cache-control "no-cache" --content-type "text/markdown; charset=utf-8" --only-show-errors
	written+=("/${prefix}/brief.json" "/${prefix}/brief.md")
fi
if [[ -f "$status_out" ]]; then
	run aws s3 cp "$status_out" "${base}/${prefix}/status.json" \
		--cache-control "no-cache" --content-type "application/json" --only-show-errors
	written+=("/${prefix}/status.json")
fi
run aws s3 cp "$work/project.json" "${base}/${project}/index.json" \
	--cache-control "no-cache" --content-type "application/json" --only-show-errors

# The root index: every top-level folder's index.json (this project's from the file just written).
mkdir -p "$work/projects"
cp "$work/project.json" "$work/projects/${project}.json"
for p in $(aws s3api list-objects-v2 --bucket "$bucket" --delimiter / --query 'CommonPrefixes[].Prefix' --output text); do
	p="${p%/}"
	[[ "$p" =~ ^[a-z0-9][a-z0-9-]{0,62}$ && "$p" != "$project" ]] || continue
	aws s3 cp "${base}/${p}/index.json" "$work/projects/${p}.json" --only-show-errors 2>/dev/null || true
done
python3 -I "$helper" index root "$work/projects" "$work/index.json"
run aws s3 cp "$work/index.json" "${base}/index.json" \
	--cache-control "no-cache" --content-type "application/json" --only-show-errors

if [[ "$mode" == publish ]]; then
	paths=("/index.json" "/index.html" "/" "/${project}/*")
else
	paths=("/index.json" "/${project}/index.json" ${written[@]+"${written[@]}"})
fi
run aws cloudfront create-invalidation --distribution-id "$dist" --paths "${paths[@]}" \
	--query Invalidation.Id --output text
echo "https://${bucket}/${prefix}/"
