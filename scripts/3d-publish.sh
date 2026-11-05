#!/usr/bin/env bash
#
# Publish one CAD project revision to https://3d.krashidbuilt.com, attach its brief, or change
# its status.
#
#   scripts/3d-publish.sh --project passport --project-title "Passport enclosure" \
#     --rev "$(git rev-parse --short HEAD)" --title "Passport enclosure v0 (454261 cell)" \
#     --dir cad/enclosure/out/viewer --renders cad/enclosure/renders [--thumb face_on.png] \
#     [--brief cad/enclosure/briefs/<rev>.md]
#   scripts/3d-publish.sh --project passport --rev <rev> --brief <file.md> [--at ISO]
#   scripts/3d-publish.sh --project passport --set-status <rev> superseded --superseded-by <rev2> \
#     --reason "replaced by the controls v3 set" [--at ISO]
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
#                         first); the revision page then shows "Superseded by <rev>" itself
#   --at ISO8601          when the brief or status change happened (default now; with --dir, the
#                         --date). Orders the "last updated" view
#   --bucket NAME         default: SSM /platform/3d/bucket
#   --distribution-id ID  default: SSM /platform/3d/distribution-id
#   --dry-run             print what would happen, change nothing
#
# BRIEF FORMAT (checked by scripts/3d-publish.py brief validate FILE...): front matter between
# '---' lines with title (<= 100), summary (one line, <= 200), status, and optionally
# status_reason, parent and superseded_by (revision ids), numbers ('  - <label>: <value>', <= 12)
# and links ('  - <label>: <http(s) url>', <= 10); then markdown with the H2 sections
# '## What changed', '## Limitations' and '## Recommendation' (others allowed). <= 32 KiB.
#
# A revision is immutable by convention: a new sha is a new folder. Re-publishing the same rev
# replaces only that folder (files it no longer has are deleted; brief.json, brief.md and
# status.json, the source of truth for brief and status, are kept). Revision files get a long
# cache; index.json, brief and status files are no-cache.
# /<project>/index.json is that project's entry and /index.json is rebuilt from every project's
# index.json, so a lost race on the root heals on the next publish. A brief or status change
# reads /<project>/index.json fail-closed. Needs the aws CLI (AWS_PROFILE, or the 3d-publisher
# keys in the environment) and python3.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${here}/3d-publish.py"

usage() {
	sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
}

project="" project_title="" rev="" title="" dir="" renders="" thumb="" date="" bucket="" dist="" dry=0
brief="" replace_brief=0 status_rev="" status="" reason="" superseded_by="" at=""
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

if [[ -n "$status_rev" ]]; then
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
	[[ -n "$brief" ]] || die "nothing to do: give --dir (publish), --brief (attach a brief) or --set-status"
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
[[ -f "$helper" ]] || die "missing ${helper}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

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
# The revision page shows "Superseded by <rev>" from its own status.json (see page inject).
banner_page() { # <page.html> → uploads it when the banner was missing or old
	local rc=0
	python3 -I "$helper" page inject "$1" "$work/page.html" || rc=$?
	case $rc in
		0) run aws s3 cp "$work/page.html" "${base}/${prefix}/index.html" \
			--cache-control "no-cache" --content-type "text/html; charset=utf-8" --only-show-errors
			page_changed=1 ;;
		3) ;;
		*) die "could not add the status banner to ${prefix}/index.html" ;;
	esac
}
page_changed=0

# The renders' file names, thumbnail first, for the index page's carousel.
render_names=""
if [[ -n "$renders" ]]; then
	render_names="$( { [[ -n "$thumb" ]] && echo "$thumb"; find "$renders" -maxdepth 1 -name '*.png' -exec basename {} \; | LC_ALL=C sort | grep -vxF "${thumb:-/}"; } || true)"
fi

if [[ "$mode" == publish ]]; then
	echo "publishing ${dir} -> https://${bucket}/${prefix}/"
	# Everything but the page with a long cache, then the page itself no-cache (CloudFront serves
	# *.html no-store anyway). --delete keeps a re-published rev identical to its directory, renders
	# (their own sync below) and the brief excepted.
	run aws s3 sync "$dir" "${base}/${prefix}/" --delete --exclude "renders/*" --exclude "*.html" \
		--exclude "brief.json" --exclude "brief.md" --exclude "status.json" \
		--cache-control "$long" --only-show-errors
	run aws s3 sync "$dir" "${base}/${prefix}/" --exclude "*" --include "*.html" \
		--cache-control "no-cache" --content-type "text/html; charset=utf-8" --only-show-errors
	if [[ -n "$renders" ]]; then
		run aws s3 sync "$renders" "${base}/${prefix}/renders/" --delete --exclude "*" --include "*.png" \
			--cache-control "$long" --only-show-errors
	fi
fi

# The project's own index. A publish may start it (any read error = a new project, as before);
# a brief or status change needs the revision to be there, so it reads fail-closed.
if aws s3 cp "${base}/${project}/index.json" "$work/project.json" --only-show-errors 2>"$work/read.err"; then :; else
	[[ "$mode" == publish ]] || die "cannot read ${base}/${project}/index.json: $(cat "$work/read.err")"
	echo '{}' >"$work/project.json"
fi
case "$mode" in
	publish)
		THREED_PROJECT="$project" THREED_PROJECT_TITLE="$project_title" THREED_REV="$rev" THREED_TITLE="$title" \
			THREED_DATE="$date" THREED_AT="$at" THREED_THUMB="$thumb" THREED_RENDERS="$render_names" \
			python3 -I "$helper" index publish "$work/project.json"
		;;
	brief | status)
		read_optional "${prefix}/index.html" "$work/live.html" || die "${prefix}/index.html is not on the bucket"
		;;
esac
status_in="$work/status.json" status_out="$work/status.new.json"
if [[ "$mode" != publish || -n "$brief" ]]; then
	read_optional "${prefix}/status.json" "$status_in" || :
fi
case "$mode" in
	brief)
		# Renders already on the bucket, for an older revision whose entry does not list them.
		render_names="$(aws s3api list-objects-v2 --bucket "$bucket" --prefix "${prefix}/renders/" \
			--query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n' | grep -E '\.png$' | sed 's#.*/##' || true)"
		;;
	status)
		THREED_PROJECT="$project" THREED_REV="$rev" THREED_STATUS="$status" THREED_REASON="$reason" \
			THREED_SUPERSEDED_BY="$superseded_by" THREED_AT="$at" \
			python3 -I "$helper" index status "$work/project.json" "$status_in" "$status_out" || exit 2
		;;
esac
if [[ -n "$brief" ]]; then
	THREED_RENDERS="$render_names" THREED_REPLACE_BRIEF="$replace_brief" \
		python3 -I "$helper" index brief "$work/project.json" "$work/brief.json" "$status_in" "$status_out" || exit 2
	run aws s3 cp "$work/brief.json" "${base}/${prefix}/brief.json" \
		--cache-control "no-cache" --content-type "application/json" --only-show-errors
	run aws s3 cp "$brief" "${base}/${prefix}/brief.md" \
		--cache-control "no-cache" --content-type "text/markdown; charset=utf-8" --only-show-errors
fi
if [[ -f "$status_out" ]]; then
	run aws s3 cp "$status_out" "${base}/${prefix}/status.json" \
		--cache-control "no-cache" --content-type "application/json" --only-show-errors
fi
# The page gets the banner once the revision has a status (a publish without one is unchanged).
if [[ "$mode" != publish ]]; then
	banner_page "$work/live.html"
elif python3 -I "$helper" index has-status "$work/project.json" "$rev"; then
	banner_page "$dir/index.html"
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
	paths=("/index.json" "/${project}/index.json" "/${prefix}/brief.json" "/${prefix}/brief.md" "/${prefix}/status.json")
	[[ $page_changed -eq 0 ]] || paths+=("/${prefix}/" "/${prefix}/index.html")
fi
run aws cloudfront create-invalidation --distribution-id "$dist" --paths "${paths[@]}" \
	--query Invalidation.Id --output text
echo "https://${bucket}/${prefix}/"
