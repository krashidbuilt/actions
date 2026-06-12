#!/bin/bash
# Bootstrap a SECOND Gitea runner on a Mac: linux-container CI jobs via
# Docker Desktop (labels ubuntu-latest / ubuntu-22.04). Companion to
# setup-macos-gitea-runner.sh (which installs the host-mode macos-arm64
# runner). First deployed on bens-mac-studio 2026-06-11 to take verify/test
# load off the NAS (DS923+, 8 threads) — the Studio (M3 Ultra, 32 cores)
# runs capacity 6 vs the NAS's fallback capacity 2.
#
# Usage (run on the target Mac, Docker Desktop already installed + running):
#   GITEA_RUNNER_REG_TOKEN=<token> \
#   bash scripts/setup-macos-linux-ci-runner.sh
#
#   Org-level registration token:
#     curl -sS -X POST -H "Authorization: token $GITEA_TOKEN" \
#       https://git.dsm.krashidbuilt.com/api/v1/orgs/krashidbuilt/actions/runners/registration-token
#
# Optional env:
#   GITEA_INSTANCE   — default https://git.dsm.krashidbuilt.com
#   RUNNER_NAME      — default $(hostname -s)-linux
#   RUNNER_CAPACITY  — default 6 (concurrent jobs; size to cores/4-ish)
#   RUNNER_VERSION   — default 1.0.8
#
# Hard-won ordering + gotchas (see atlas
# content/engineering/memories/studio-linux-runner-gotchas-2026-06-11.md):
#   1. BUILD IMAGE + WRITE CONFIG BEFORE REGISTERING. A registered runner
#      claims queued jobs immediately — half-configured runners fail real
#      CI runs and block promotions.
#   2. force_pull MUST be false: labels point at a local-only image tag;
#      force_pull=true (the generate-config default) tries a registry pull
#      and fails with "pull access denied".
#   3. Docker's osxkeychain credsStore breaks docker over SSH ("keychain
#      cannot be accessed"). The runner gets its own DOCKER_CONFIG dir
#      with a bare {} — all images here are public or local.
#   4. config.yaml labels override registration labels on every daemon
#      start — keep them identical in both places.
#   5. The job image mirrors nas-infra
#      services/gitea-runner/job-images/ubuntu-22.04 (curl/unzip/jq +
#      AWS CLI v2) but with the aarch64 AWS bundle, so jobs behave the
#      same on either runner. NAS-host-touching jobs stay pinned to the
#      `self-hosted` label, which this runner deliberately does NOT have.

set -euo pipefail

GITEA_INSTANCE="${GITEA_INSTANCE:-https://git.dsm.krashidbuilt.com}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname -s)-linux}"
RUNNER_CAPACITY="${RUNNER_CAPACITY:-6}"
RUNNER_VERSION="${RUNNER_VERSION:-1.0.8}"
RUNNER_BIN="$HOME/.local/bin/gitea-runner"
RUNNER_HOME="$HOME/.gitea-runner-linux"
JOB_IMAGE="studio-job-ubuntu-22.04:local"
LABEL="com.krashidbuilt.gitea-runner-linux"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/gitea-runner-linux.log"
DOCKER_BIN="/Applications/Docker.app/Contents/Resources/bin/docker"

err() { printf 'ERR: %s\n' "$1" >&2; exit 1; }
ok() { printf 'OK:  %s\n' "$1"; }

[[ -n "${GITEA_RUNNER_REG_TOKEN:-}" ]] || err "GITEA_RUNNER_REG_TOKEN not set"
[[ -x "$DOCKER_BIN" ]] || err "Docker Desktop not installed at /Applications/Docker.app"
[[ "$(uname -m)" == "arm64" ]] || err "expected arm64 Mac (got $(uname -m))"

mkdir -p "$HOME/.local/bin" "$RUNNER_HOME/job-image" "$RUNNER_HOME/docker-config"
ln -sf "$DOCKER_BIN" "$HOME/.local/bin/docker"

# Helper-free docker config (gotcha 3).
echo "{}" > "$RUNNER_HOME/docker-config/config.json"
export DOCKER_CONFIG="$RUNNER_HOME/docker-config"

# Ensure the daemon is up (Docker Desktop starts on `open -a Docker`).
"$DOCKER_BIN" info >/dev/null 2>&1 || { open -a Docker; sleep 25; }
"$DOCKER_BIN" info >/dev/null 2>&1 || err "docker daemon not reachable"

# ── 1. Job image (BEFORE registration — gotcha 1) ──
cat > "$RUNNER_HOME/job-image/Dockerfile" <<'EOF'
# arm64 mirror of nas-infra services/gitea-runner/job-images/ubuntu-22.04 —
# same tools so ubuntu-latest jobs behave identically on NAS (x86) and
# Mac (arm64). AWS CLI uses the aarch64 bundle.
FROM catthehacker/ubuntu:act-22.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip jq \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install \
 && rm -rf /tmp/awscliv2.zip /tmp/aws /var/lib/apt/lists/* \
 && aws --version && jq --version && which unzip
EOF
"$DOCKER_BIN" build -t "$JOB_IMAGE" "$RUNNER_HOME/job-image"
ok "job image $JOB_IMAGE built"

# ── 2. Runner binary ──
if [[ ! -x "$RUNNER_BIN" ]] || ! "$RUNNER_BIN" --version 2>/dev/null | grep -q "v$RUNNER_VERSION"; then
  curl -sSL -m 300 -o "$RUNNER_BIN" \
    "https://dl.gitea.com/gitea-runner/${RUNNER_VERSION}/gitea-runner-${RUNNER_VERSION}-darwin-arm64"
  chmod +x "$RUNNER_BIN"
fi
ok "gitea-runner $("$RUNNER_BIN" --version 2>&1)"

# ── 3. Config (BEFORE registration — gotchas 1, 2, 4) ──
if [[ ! -f "$RUNNER_HOME/config.yaml" ]]; then
  (cd "$RUNNER_HOME" && "$RUNNER_BIN" generate-config > config.yaml)
fi
python3 - "$RUNNER_HOME/config.yaml" "$RUNNER_CAPACITY" "$JOB_IMAGE" <<'PYEOF'
import re, sys
p, cap, img = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
s = re.sub(r"  capacity: \d+", f"  capacity: {cap}", s)
s = re.sub(r"  force_pull: true", "  force_pull: false", s)
# docker_host "-" = do NOT mount a docker socket into job containers.
# Docker Desktop cannot bind-mount mac-host unix sockets into linux
# containers (gRPC-FUSE: "operation not supported" — broke the 2023's
# first jobs); our CI jobs never need docker-in-docker anyway. The
# daemon itself reaches the engine via DOCKER_HOST in the LaunchAgent.
s = re.sub(r"  docker_host: .*", '  docker_host: \"-\"', s)
labels = f'  labels:\n    - "ubuntu-latest:docker://{img}"\n    - "ubuntu-22.04:docker://{img}"\n'
s = re.sub(r"  labels:\n(    - .*\n)+", labels, s)
open(p, "w").write(s)
print(f"config: capacity={cap}, force_pull=false, labels -> {img}")
PYEOF

# ── 4. Register (LAST — gotcha 1; idempotent) ──
if [[ -f "$RUNNER_HOME/.runner" ]]; then
  ok "already registered — skipping"
else
  (cd "$RUNNER_HOME" && "$RUNNER_BIN" register --no-interactive \
    --instance "$GITEA_INSTANCE" \
    --token "$GITEA_RUNNER_REG_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "ubuntu-latest:docker://$JOB_IMAGE,ubuntu-22.04:docker://$JOB_IMAGE")
  ok "registered as $RUNNER_NAME"
fi

# ── 5. LaunchAgent ──
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$RUNNER_BIN</string>
		<string>daemon</string>
		<string>--config</string>
		<string>$RUNNER_HOME/config.yaml</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$RUNNER_HOME</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/Applications/Docker.app/Contents/Resources/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>DOCKER_HOST</key>
		<string>unix://$HOME/.docker/run/docker.sock</string>
		<key>DOCKER_CONFIG</key>
		<string>$RUNNER_HOME/docker-config</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$LOG</string>
	<key>StandardErrorPath</key>
	<string>$LOG</string>
	<key>ThrottleInterval</key>
	<integer>10</integer>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 3
launchctl list | grep -q "$LABEL" && ok "runner daemon running — verify labels in $LOG" || err "daemon failed — see $LOG"
