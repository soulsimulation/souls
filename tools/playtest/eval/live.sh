#!/usr/bin/env bash
# Soul Client eval (#1752 A4): run `soul-eval.mjs run` with a live seat in a clean environment, so results compare between
# machines and agents. Only #1688's allowlist reaches the seat, and Claude Code reads an isolated config directory, never
# the operator's own (no personal CLAUDE.md, MCP servers, plugins or memory).
#
#   SEAT_CONFIG_DIR=<isolated, signed-in Claude config dir> tools/playtest/eval/live.sh --seat tools/playtest/eval/seats/claude-sonnet.json --max-usd 1 ...
#
# Nothing is copied into or out of SEAT_CONFIG_DIR. Take the playtest lock first when the machine is shared.
set -euo pipefail
: "${SEAT_CONFIG_DIR:?set SEAT_CONFIG_DIR to the isolated Claude config directory}"
here="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_CONFIG_DIR="$SEAT_CONFIG_DIR" claude auth status 2>/dev/null | grep -q '"loggedIn": true' || { echo "seat config is not signed in: stopped" >&2; exit 9; }
exec env -i HOME="$HOME" PATH="$PATH" USER="${USER:-}" LOGNAME="${LOGNAME:-}" LANG="${LANG:-en_US.UTF-8}" TERM="${TERM:-dumb}" \
  CLAUDE_CONFIG_DIR="$SEAT_CONFIG_DIR" node "$here/soul-eval.mjs" run "$@"
