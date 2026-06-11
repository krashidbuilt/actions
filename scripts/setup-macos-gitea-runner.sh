#!/bin/bash
# Bootstrap a Gitea Actions runner on a Mac (org-level, host mode).
#
# Installs gitea-runner as a LaunchAgent in the user's GUI session so jobs
# can use the login/atlas-signing keychain (codesign) and launchctl
# (restarting worker agents). First used on bens-mac-studio 2026-06-11 to
# automate atlas worker deploys (atlas .gitea/workflows/deploy-mac.yml).
#
# Usage (run on the target Mac):
#   GITEA_RUNNER_REG_TOKEN=<token> \
#   bash scripts/setup-macos-gitea-runner.sh
#
#   Get the org-level registration token with an org-admin API token:
#     curl -sS -X POST -H "Authorization: token $GITEA_TOKEN" \
#       https://git.dsm.krashidbuilt.com/api/v1/orgs/krashidbuilt/actions/runners/registration-token
#
# Optional env:
#   GITEA_INSTANCE   — default https://git.dsm.krashidbuilt.com
#   RUNNER_NAME      — default $(hostname -s)
#   RUNNER_LABELS    — default "macos-arm64:host"
#   RUNNER_VERSION   — default 1.0.8
#
# Host-mode caveats (read before writing workflows for this runner):
#   - No docker on the Mac: jobs run directly on the host. Label suffix
#     `:host` is what makes act/gitea-runner skip containers.
#   - No node runtime is installed by this script, so `uses:` JS actions
#     (actions/checkout, actions/cache, ...) will NOT work. Write plain
#     `run:` steps and clone with git + token URL.
#   - The runner LaunchAgent only loads in a logged-in GUI session
#     (LimitLoadToSessionType Aqua is intentionally NOT set, but
#     gui/$UID bootstrap requires an active session). Keep the Mac
#     logged in, with sleep disabled, like the worker Macs.

set -euo pipefail

GITEA_INSTANCE="${GITEA_INSTANCE:-https://git.dsm.krashidbuilt.com}"
RUNNER_NAME="${RUNNER_NAME:-$(hostname -s)}"
RUNNER_LABELS="${RUNNER_LABELS:-macos-arm64:host}"
RUNNER_VERSION="${RUNNER_VERSION:-1.0.8}"
RUNNER_BIN="$HOME/.local/bin/gitea-runner"
RUNNER_HOME="$HOME/.gitea-runner"
LABEL="com.krashidbuilt.gitea-runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/gitea-runner.log"

err() { printf 'ERR: %s\n' "$1" >&2; exit 1; }
ok() { printf 'OK:  %s\n' "$1"; }

[[ -n "${GITEA_RUNNER_REG_TOKEN:-}" ]] || err "GITEA_RUNNER_REG_TOKEN not set"
[[ "$(uname -m)" == "arm64" ]] || err "expected arm64 Mac (got $(uname -m))"

mkdir -p "$HOME/.local/bin" "$RUNNER_HOME"

# ── Download pinned runner binary ──
if [[ ! -x "$RUNNER_BIN" ]] || ! "$RUNNER_BIN" --version 2>/dev/null | grep -q "v$RUNNER_VERSION"; then
  curl -sSL -m 300 -o "$RUNNER_BIN" \
    "https://dl.gitea.com/gitea-runner/${RUNNER_VERSION}/gitea-runner-${RUNNER_VERSION}-darwin-arm64"
  chmod +x "$RUNNER_BIN"
fi
ok "gitea-runner $("$RUNNER_BIN" --version 2>&1)"

# ── Register (idempotent: skip if .runner config already exists) ──
if [[ -f "$RUNNER_HOME/.runner" ]]; then
  ok "already registered ($RUNNER_HOME/.runner exists) — skipping registration"
else
  (cd "$RUNNER_HOME" && "$RUNNER_BIN" register --no-interactive \
    --instance "$GITEA_INSTANCE" \
    --token "$GITEA_RUNNER_REG_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS")
  ok "registered as $RUNNER_NAME with labels $RUNNER_LABELS"
fi

# ── LaunchAgent ──
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
	</array>
	<key>WorkingDirectory</key>
	<string>$RUNNER_HOME</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
sleep 2
if launchctl list | grep -q "$LABEL"; then
  ok "runner daemon running — check $LOG and the org runners page"
else
  err "runner daemon failed to start — see $LOG"
fi
