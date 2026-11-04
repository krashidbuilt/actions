#!/usr/bin/env bash
#
# Publish one CAD project revision to https://3d.krashidbuilt.com.
#
#   scripts/3d-publish.sh --project passport --project-title "Passport enclosure" \
#     --rev "$(git rev-parse --short HEAD)" --title "Passport enclosure v0 (454261 cell)" \
#     --dir cad/enclosure/out/viewer --renders cad/enclosure/renders [--thumb face_on.png]
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
#   --bucket NAME         default: SSM /platform/3d/bucket
#   --distribution-id ID  default: SSM /platform/3d/distribution-id
#   --dry-run             print what would happen, change nothing
#
# A revision is immutable by convention: a new sha is a new folder. Re-publishing the same rev
# replaces only that folder (files it no longer has are deleted). Revision files get a long
# cache; index.json files are no-cache. /<project>/index.json is that project's entry and
# /index.json is rebuilt from every project's index.json, so a lost race on the root heals on the
# next publish. Needs the aws CLI (AWS_PROFILE, or the 3d-publisher keys in the environment) and
# python3.

set -euo pipefail

usage() {
	sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}

project="" project_title="" rev="" title="" dir="" renders="" thumb="" date="" bucket="" dist="" dry=0
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
		--bucket) bucket="${2:-}"; shift 2 ;;
		--distribution-id) dist="${2:-}"; shift 2 ;;
		--dry-run) dry=1; shift ;;
		-h | --help) usage ;;
		*) echo "3d-publish: unknown argument $1" >&2; usage ;;
	esac
done

die() { echo "3d-publish: $*" >&2; exit 2; }
[[ "$project" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "--project must match [a-z0-9][a-z0-9-]{0,62} (got '${project}')"
[[ "$rev" =~ ^[A-Za-z0-9._-]{1,64}$ && "$rev" != "." && "$rev" != ".." ]] || die "--rev must match [A-Za-z0-9._-]{1,64} (got '${rev}')"
[[ -n "$dir" && -f "$dir/index.html" ]] || die "--dir must be a cadkit viewer --sidecar directory with index.html (got '${dir}')"
[[ -z "$renders" || -d "$renders" ]] || die "--renders is not a directory: ${renders}"
[[ -z "$thumb" || "$thumb" =~ ^[A-Za-z0-9._-]+\.png$ ]] || die "--thumb is a PNG file name inside --renders"
[[ -n "$date" ]] || date="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+Z?)?$ ]] || die "--date must be ISO 8601 (got '${date}')"
command -v aws >/dev/null || die "the aws CLI is not on PATH"
command -v python3 >/dev/null || die "python3 is not on PATH"

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
base="s3://${bucket}"
long="public, max-age=31536000, immutable"
run() {
	if [[ $dry -eq 1 ]]; then printf 'dry-run:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

echo "publishing ${dir} -> https://${bucket}/${prefix}/"
# Everything but the page with a long cache, then the page itself no-cache (CloudFront serves
# *.html no-store anyway). --delete keeps a re-published rev identical to its directory, renders
# excepted (they get their own sync below).
run aws s3 sync "$dir" "${base}/${prefix}/" --delete --exclude "renders/*" --exclude "*.html" \
	--cache-control "$long" --only-show-errors
run aws s3 sync "$dir" "${base}/${prefix}/" --exclude "*" --include "*.html" \
	--cache-control "no-cache" --content-type "text/html; charset=utf-8" --only-show-errors
if [[ -n "$renders" ]]; then
	run aws s3 sync "$renders" "${base}/${prefix}/renders/" --delete --exclude "*" --include "*.png" \
		--cache-control "$long" --only-show-errors
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The project's own index: download (or start), upsert this revision, newest first.
if aws s3 cp "${base}/${project}/index.json" "$work/project.json" --only-show-errors 2>/dev/null; then :; else
	echo '{}' >"$work/project.json"
fi
THREED_PROJECT="$project" THREED_PROJECT_TITLE="$project_title" THREED_REV="$rev" THREED_TITLE="$title" \
	THREED_DATE="$date" THREED_THUMB="$thumb" python3 -I - "$work/project.json" <<'PY'
import json, os, sys

path = sys.argv[1]
try:
    entry = json.load(open(path))
    if not isinstance(entry, dict):
        entry = {}
except ValueError:
    entry = {}
project, rev = os.environ["THREED_PROJECT"], os.environ["THREED_REV"]
revs = [r for r in entry.get("revisions", []) if isinstance(r, dict) and r.get("rev") != rev]
thumb = os.environ["THREED_THUMB"]
revs.append({
    "rev": rev,
    "date": os.environ["THREED_DATE"],
    "title": os.environ["THREED_TITLE"] or rev,
    "path": f"/{project}/{rev}/",
    "thumb": f"/{project}/{rev}/renders/{thumb}" if thumb else None,
})
revs.sort(key=lambda r: str(r.get("date", "")), reverse=True)
entry = {
    "id": project,
    "title": os.environ["THREED_PROJECT_TITLE"] or entry.get("title") or project,
    "revisions": revs,
}
json.dump(entry, open(path, "w"), indent=1)
print(f"{project}: {len(revs)} revision(s), latest {revs[0]['rev']}")
PY
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
python3 -I - "$work/projects" "$work/index.json" <<'PY'
import json, os, sys

src, out = sys.argv[1], sys.argv[2]
projects = []
for name in sorted(os.listdir(src)):
    try:
        entry = json.load(open(os.path.join(src, name)))
    except ValueError:
        continue
    if isinstance(entry, dict) and entry.get("id") and entry.get("revisions"):
        projects.append(entry)
projects.sort(key=lambda p: str(p["revisions"][0].get("date", "")), reverse=True)
json.dump({"projects": projects}, open(out, "w"), indent=1)
print("index:", ", ".join(p["id"] for p in projects))
PY
run aws s3 cp "$work/index.json" "${base}/index.json" \
	--cache-control "no-cache" --content-type "application/json" --only-show-errors

run aws cloudfront create-invalidation --distribution-id "$dist" \
	--paths "/index.json" "/index.html" "/" "/${project}/*" --query Invalidation.Id --output text
echo "https://${bucket}/${prefix}/"
