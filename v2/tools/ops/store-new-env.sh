#!/usr/bin/env bash
# Write the production host's /etc/souls/store-new.env, the file store-switch.sh moves the worlds' bucket to: R2's
# `soul-game-worlds` on the soul.game Cloudflare account. Run on the operator's machine, not the host.
#
#   bash v2/tools/ops/store-new-env.sh plan  [<secrets file>]   the file it would write, keys shown as <set>; sends nothing
#   bash v2/tools/ops/store-new-env.sh apply [<secrets file>]   writes it on the host (root, mode 600) over ssh's stdin
#   bash v2/tools/ops/store-new-env.sh undo                     removes it from the host (store-switch.sh no longer finds it)
#
# The secrets file (default: the main checkout's .local/project/team/secrets/r2-soul-game.env, mode 600) holds
# R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), WORLDS_ACCESS_KEY_ID and WORLDS_SECRET_ACCESS_KEY (an R2
# token for that bucket alone, object read and write). The file written is store-switch.sh's form:
#
#   STORE_BASE=s3:<R2_ENDPOINT>/soul-game-worlds        (no prefix: each setting keeps its own)
#   AWS_ACCESS_KEY_ID=<WORLDS_ACCESS_KEY_ID>
#   AWS_SECRET_ACCESS_KEY=<WORLDS_SECRET_ACCESS_KEY>
#   AWS_DEFAULT_REGION=auto
#
# Keys pass through stdin only: never a command line, never printed. The host is the deploy settings' target
# (SIM_DEPLOY_HOST, SIM_DEPLOY_USER; tools/world-launcher/deploy/deploy-env.sh). STORE_NEW_REMOTE replaces the ssh
# command and STORE_NEW_DEST the path (tests: v2/tools/ops/store-new-env.test.mjs).
set -euo pipefail
umask 077
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUCKET=${STORE_NEW_BUCKET:-soul-game-worlds}
DEST=${STORE_NEW_DEST:-/etc/souls/store-new.env}

die() {
  echo "store-new-env: $*" >&2
  exit 2
}

default_secrets() {
  local common
  common=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2> /dev/null) || die "not in a checkout: name the secrets file"
  echo "$(dirname "$common")/.local/project/team/secrets/r2-soul-game.env"
}

value() { awk -v k="$1" '{ sub(/^export /, "") } index($0, k "=") == 1 { v = substr($0, length(k) + 2); gsub(/^["\047]|["\047]$/, "", v); print v; exit }' "$2"; }

# The file's text on stdout (for a pipe only).
compose() {
  local f=$1 ep id key
  [ -f "$f" ] || die "no $f"
  [ "$(stat -c %a "$f" 2> /dev/null || stat -f %Lp "$f")" = 600 ] || die "$f must be mode 600"
  ep=$(value R2_ENDPOINT "$f")
  id=$(value WORLDS_ACCESS_KEY_ID "$f")
  key=$(value WORLDS_SECRET_ACCESS_KEY "$f")
  [[ "$ep" =~ ^https://[a-z0-9.-]+$ ]] || die "R2_ENDPOINT in $f is https://<account>.r2.cloudflarestorage.com, no path"
  [ -n "$id" ] && [ -n "$key" ] || die "$f has no WORLDS_ACCESS_KEY_ID or WORLDS_SECRET_ACCESS_KEY"
  printf '# store-new-env.sh: the store store-switch.sh moves the worlds to (R2 %s). Root, mode 600.\n' "$BUCKET"
  printf 'STORE_BASE=s3:%s/%s\nAWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=auto\n' "$ep" "$BUCKET" "$id" "$key"
}

remote() {
  if [ -n "${STORE_NEW_REMOTE:-}" ]; then
    # shellcheck disable=SC2086 # a command with its words, e.g. "bash -c"
    $STORE_NEW_REMOTE "$1"
    return
  fi
  # shellcheck source=../../../tools/world-launcher/deploy/deploy-env.sh
  . "$HERE/../../../tools/world-launcher/deploy/deploy-env.sh"
  ssh -o BatchMode=yes "$(deploy_target)" "$1"
}

case ${1:-} in
  plan)
    compose "${2:-$(default_secrets)}" | sed -E 's/^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=.*/\1=<set>/; s|^STORE_BASE=s3:https://[^/]+/|STORE_BASE=s3:https://<account endpoint>/|'
    echo "store-new-env: plan only; apply writes this to $DEST on the host (root, mode 600)"
    ;;
  apply)
    compose "${2:-$(default_secrets)}" | remote "umask 077; cat > '$DEST.tmp' && chmod 600 '$DEST.tmp' && mv -f '$DEST.tmp' '$DEST' && echo 'store-new-env: wrote $DEST (mode 600)'"
    ;;
  undo)
    remote "rm -f '$DEST' && echo 'store-new-env: removed $DEST'"
    ;;
  *)
    sed -n 2,20p "$0"
    exit 2
    ;;
esac
