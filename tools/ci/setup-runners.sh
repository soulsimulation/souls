#!/usr/bin/env bash
# Set up N self-hosted GitHub Actions runner instances for this repository on one Linux host, each a systemd service
# running as one dedicated unprivileged user, with the label the CI's heavy jobs ask for (CI_HEAVY_RUNNER, docs/testing.md).
#
# Run it ON the runner host as root. It is idempotent: an instance that is already registered is only (re)started, and
# the user, packages and runner download are reused. Nothing here names a host, user or address: pass them in.
#
#   sudo bash tools/ci/setup-runners.sh --token <registration token> [--count 4] [--user <runner user>] \
#        [--label souls-ci] [--prefix souls-ci] [--repo soulsimulation/souls] [--root /opt] [--version <x.y.z>] [--no-playwright] \
#        [--cpus <list> | --cpus-from <instance>,<instance>,... | --cpus-except <instance>,<instance>,...] [--dry-run]
#
# --cpus pins the instances' services to those CPUs (systemd CPUAffinity=, a drop-in; "0-5,24-29"). --cpus-from takes the
# union of the CPUs other instances already run on (their service's live affinity, else its CPUAffinity= or AllowedCPUs=),
# as the wide timed runner does (docs/testing.md, "Wide runner"); --cpus-except takes every other CPU of the host, as the
# light runners do beside the timed ones. --dry-run prints what it would do and changes nothing.
#
# From a workstation, without copying the file there (the token is minted with your gh login, valid for one hour):
#
#   TOKEN=$(gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token) && \
#     ssh <runner-host> "sudo bash -s -- --token $TOKEN --count 4 --user <runner user>" < tools/ci/setup-runners.sh
#
# One instance runs one job at a time, so --count is the number of parallel heavy CI legs the host takes on.
set -euo pipefail

TOKEN="" COUNT=4 RUNNER_USER="ci-runner" LABEL="souls-ci" PREFIX="souls-ci" REPO="soulsimulation/souls" ROOT="/opt" VERSION="" PLAYWRIGHT=1
CPUS_ARG="" CPUS_FROM="" CPUS_OPT="--cpus-from" EXCEPT=0 DRY=0
# The Playwright the repository locks (pnpm-lock.yaml); its install-deps knows each supported OS's package names.
PLAYWRIGHT_VERSION="1.64.1"
# Tests only (setup-runners.test.mjs): a directory standing in for / when reading /etc, /proc and /sys and writing units.
SYS="${SETUP_RUNNERS_SYSROOT:-}"
UNIT_DIR="$SYS/etc/systemd/system"

usage() { sed -n '2,22p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }
die() { echo "setup-runners: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --count) COUNT="${2:-}"; shift 2 ;;
    --user) RUNNER_USER="${2:-}"; shift 2 ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --no-playwright) PLAYWRIGHT=0; shift ;;
    --cpus) CPUS_ARG="${2:-}"; shift 2 ;;
    --cpus-from|--cpus-except) [ -z "$CPUS_FROM" ] || die "--cpus-from and --cpus-except: one or the other"
      CPUS_OPT="$1"; [ "$1" = --cpus-except ] && EXCEPT=1; CPUS_FROM="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (--help lists them)" ;;
  esac
done

[ -n "$TOKEN" ] || die "--token is required (gh api -X POST repos/$REPO/actions/runners/registration-token --jq .token)"
[[ "$COUNT" =~ ^[1-9][0-9]?$ ]] || die "--count must be 1-99"
[[ "$RUNNER_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--user must be a plain user name"
[[ "$PREFIX" =~ ^[A-Za-z0-9_-]+$ && "$LABEL" =~ ^[A-Za-z0-9_-]+$ ]] || die "--prefix and --label: letters, digits, - and _"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be owner/name"
[ -z "$CPUS_ARG" ] || [ -z "$CPUS_FROM" ] || die "--cpus and $CPUS_OPT: one or the other"
[ -z "$CPUS_ARG" ] || [[ "$CPUS_ARG" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] || die "--cpus must be a CPU list such as 0-5,24-29"
[ -z "$CPUS_FROM" ] || [[ "$CPUS_FROM" =~ ^[A-Za-z0-9_-]+(,[A-Za-z0-9_-]+)*$ ]] || die "$CPUS_OPT must be instance names separated by commas"
[ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || die "run as root (sudo bash $0 ...)"
[ "$(uname -s)" = Linux ] || die "Linux only"
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac

# a mutating step: run it, or under --dry-run say it
act() { if [ "$DRY" = 1 ]; then echo "   would run: $*"; else "$@"; fi; }
act_quiet() { if [ "$DRY" = 1 ]; then echo "   would run: $*"; else "$@" >/dev/null; fi; }

# ---- CPU lists: "0-2,24-26" <-> one CPU per line
cpu_expand() { local r IFS=', '; for r in $1; do [ -n "$r" ] && seq "${r%-*}" "${r#*-}"; done; }
cpu_compress() { awk 'function out() { printf "%s%s%s", sep, s, (s == p ? "" : "-" p); sep = "," }
  NR == 1 { s = p = $1; next } $1 == p + 1 { p = $1; next } { out(); s = p = $1 } END { if (NR) { out(); print "" } }'; }
cpu_norm() { cpu_expand "$1" | sort -n -u | cpu_compress; }
# physical cores among a CPU list: distinct SMT sibling sets (a CPU with no topology file is its own core)
physical_cores() {
  local c
  for c in $(cpu_expand "$1"); do cat "$SYS/sys/devices/system/cpu/cpu$c/topology/thread_siblings_list" 2>/dev/null || echo "$c"; done | sort -u | wc -l | tr -d ' '
}
ALL_CPUS="$(cpu_norm "$(cat "$SYS/sys/devices/system/cpu/online" 2>/dev/null || echo "0-$(($(nproc) - 1))")")"

# the directory of an instance already registered under this name, wherever an earlier setup put it
registered_dir() {
  local f
  for f in "$ROOT"/*/.runner; do
    [ -f "$f" ] || continue
    if tr -d '\r\357\273\277' < "$f" | jq -e --arg n "$1" '.agentName == $n' >/dev/null 2>&1; then dirname "$f"; return 0; fi
  done
  return 1
}
# the systemd unit of an existing instance: its install's .service file, else systemd's own list
instance_unit() {
  local dir how u
  if dir="$(registered_dir "$1")" && [ -s "$dir/.service" ]; then cat "$dir/.service"; return 0; fi
  for how in "list-units --all" "list-unit-files"; do
    # shellcheck disable=SC2086
    u="$(systemctl $how --type=service --plain --no-legend "actions.runner.*.$1.service" 2>/dev/null \
      | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /\.service$/) { print $i; exit } }')"
    if [ -n "$u" ]; then echo "$u"; return 0; fi
  done
  return 1
}
# the CPUs an existing instance runs on, and where that was read: the running service's own affinity, else the unit's
# CPUAffinity= or AllowedCPUs=. A set equal to every CPU is no pinning at all, and is refused.
instance_cpus() {
  local unit pid v p
  unit="$(instance_unit "$1")" || die "$CPUS_OPT: no runner service named $1 (looked under $ROOT and in systemd's units)"
  pid="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || true)"
  if [ -n "$pid" ] && [ "$pid" != 0 ]; then
    v="$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' "$SYS/proc/$pid/status" 2>/dev/null || true)"
    if [ -n "$v" ] && [ "$(cpu_norm "$v")" != "$ALL_CPUS" ]; then echo "$(cpu_norm "$v") live"; return 0; fi
  fi
  for p in CPUAffinity AllowedCPUs; do
    v="$(systemctl show -p "$p" --value "$unit" 2>/dev/null | tr ' ' ',' || true)"
    if [ -n "$v" ] && [ "$(cpu_norm "$v")" != "$ALL_CPUS" ]; then echo "$(cpu_norm "$v") $p"; return 0; fi
  done
  die "$CPUS_OPT: $1 ($unit) is not pinned to CPUs of its own; pass --cpus instead"
}

# ---- the OS, first: it decides whether Playwright's browser packages can be installed at all
# os-release has a VERSION of its own: keep this script's runner version (#1162).
RUNNER_VERSION="$VERSION"
. "$SYS/etc/os-release"
VERSION="$RUNNER_VERSION"
OS="${ID:-unknown}-${VERSION_ID:-unknown}"
echo "== host: ${PRETTY_NAME:-$OS}, $(nproc) cores, load $(cut -d' ' -f1-3 "$SYS/proc/loadavg")"

# ---- the CPUs to pin the instances to, read before anything changes so a bad name stops here
CPUS=""
if [ -n "$CPUS_ARG" ]; then
  CPUS="$(cpu_norm "$CPUS_ARG")"
  for c in $(cpu_expand "$CPUS"); do [ -d "$SYS/sys/devices/system/cpu/cpu$c" ] || die "--cpus: there is no CPU $c on this host"; done
elif [ -n "$CPUS_FROM" ]; then
  acc=""
  for n in $(echo "$CPUS_FROM" | tr ',' ' '); do
    got="$(instance_cpus "$n")"; src="${got##* }"; got="${got% *}"
    case "$src" in live) src="the running service's affinity" ;; *) src="the unit's $src=" ;; esac
    echo "== $n: CPUs $got ($(physical_cores "$got") physical cores; read from $src)"
    acc="$acc,$got"
  done
  CPUS="$(cpu_norm "$acc")"
  if [ "$EXCEPT" = 1 ]; then
    # every online CPU outside the named instances' union
    CPUS="$(comm -23 <(cpu_expand "$ALL_CPUS" | sort -u) <(cpu_expand "$CPUS" | sort -u) | sort -n | cpu_compress)"
    [ -n "$CPUS" ] || die "--cpus-except: $CPUS_FROM use every CPU of this host; none is left"
  fi
fi
if [ -n "$CPUS" ]; then
  echo "== pinning to CPUs $CPUS: $(physical_cores "$CPUS") physical cores, $(cpu_expand "$CPUS" | wc -l | tr -d ' ') logical"
fi
[ "$DRY" = 0 ] || echo "== dry run: nothing is changed; each step it would take follows"

command -v apt-get >/dev/null || die "apt-based systems only (Debian or Ubuntu)"
export DEBIAN_FRONTEND=noninteractive
act apt-get update -qq
act_quiet apt-get install -y -qq curl ca-certificates tar git jq

# ---- the dedicated runner user: unprivileged, no sudo
if ! id "$RUNNER_USER" >/dev/null 2>&1; then
  echo "== creating user $RUNNER_USER"
  act useradd --create-home --shell /bin/bash "$RUNNER_USER"
elif id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qxE 'sudo|wheel|admin'; then
  echo "warning: $RUNNER_USER is in an admin group; CI jobs run as this user" >&2
fi

# ---- Playwright's system packages for Chromium (the browser legs)
if [ "$PLAYWRIGHT" = 1 ]; then
  case "$OS" in
    ubuntu-22.04|ubuntu-24.04|debian-12|debian-13)
      echo "== Playwright $PLAYWRIGHT_VERSION system packages for Chromium ($OS)"
      if command -v npx >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then
        act npx -y "playwright@$PLAYWRIGHT_VERSION" install-deps chromium
      else
        # no Node on the host: the same set install-deps uses for Chromium, by name (24.04 and Debian 13 use the t64 names)
        pkgs=(libnss3 libnspr4 libdbus-1-3 libdrm2 libgbm1 libxkbcommon0 libx11-6 libxcb1 libxcomposite1 libxdamage1
              libxext6 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 fonts-liberation fonts-noto-color-emoji)
        for p in libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libglib2.0-0; do
          if apt-cache show "${p}t64" >/dev/null 2>&1; then pkgs+=("${p}t64"); else pkgs+=("$p"); fi
        done
        act_quiet apt-get install -y -qq "${pkgs[@]}"
      fi ;;
    ubuntu-20.04)
      echo "warning: Playwright $PLAYWRIGHT_VERSION has no system-package list for Ubuntu 20.04; skipping it." >&2
      echo "         Browser legs stay on GitHub-hosted runners (ci.yml keeps them there); upgrade the OS to add them." >&2 ;;
    *)
      echo "warning: Playwright packages are not known for $OS; skipping them (--no-playwright silences this)." >&2 ;;
  esac
fi

# ---- the runner release
if [ -z "$VERSION" ]; then
  if [ "$DRY" = 1 ]; then VERSION="latest"
  else
    VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name)"
    VERSION="${VERSION#v}"
  fi
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || "$DRY$VERSION" = 1latest ]] || die "could not resolve the runner version ($VERSION); pass --version"
CACHE="$ROOT/.actions-runner-cache"
TARBALL="$CACHE/actions-runner-linux-$ARCH-$VERSION.tar.gz"
act mkdir -p "$CACHE"
if [ ! -s "$TARBALL" ]; then
  echo "== downloading actions/runner $VERSION ($ARCH)"
  act curl -fsSL -o "$TARBALL.part" "https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-linux-$ARCH-$VERSION.tar.gz"
  act mv "$TARBALL.part" "$TARBALL"
fi

# CPUAffinity= for one unit in a drop-in of its own; returns 0 when the drop-in changed (the service needs a restart)
pin_unit() {
  local d="$UNIT_DIR/$1.d" want
  want="$(printf '# setup-runners.sh --cpus/--cpus-from\n[Service]\nCPUAffinity=%s' "$(echo "$CPUS" | tr ',' ' ')")"
  if [ -f "$d/cpus.conf" ] && [ "$(cat "$d/cpus.conf")" = "$want" ]; then echo "   $1: CPUAffinity=$CPUS (unchanged)"; return 1; fi
  echo "   $1: CPUAffinity=$CPUS ($([ -f "$d/cpus.conf" ] && echo changed || echo new), $d/cpus.conf)"
  if [ "$DRY" = 1 ]; then printf '%s\n' "$want" | sed 's/^/   would write: /'; else mkdir -p "$d"; printf '%s\n' "$want" > "$d/cpus.conf"; fi
  act systemctl daemon-reload
  return 0
}

DEPS_DONE=0
for i in $(seq 1 "$COUNT"); do
  NAME="$PREFIX-$i"
  if DIR="$(registered_dir "$NAME")"; then
    echo "== $NAME: already registered in $DIR"
  else
    DIR="$ROOT/actions-runner-$NAME"
    echo "== $NAME: installing in $DIR"
    act mkdir -p "$DIR"
    act tar -xzf "$TARBALL" -C "$DIR"
    if [ "$DEPS_DONE" = 0 ]; then act_quiet "$DIR/bin/installdependencies.sh"; DEPS_DONE=1; fi
    act chown -R "$RUNNER_USER:$RUNNER_USER" "$DIR"
    if [ "$DRY" = 1 ]; then echo "   would run: (in $DIR, as $RUNNER_USER) ./config.sh --unattended --url https://github.com/$REPO --token <token> --name $NAME --labels $LABEL --work _work --replace"
    else ( cd "$DIR" && runuser -u "$RUNNER_USER" -- ./config.sh --unattended --url "https://github.com/$REPO" --token "$TOKEN" \
        --name "$NAME" --labels "$LABEL" --work _work --replace ); fi
  fi
  # a systemd service per instance (actions.runner.<owner>-<repo>.<name>.service), running as the runner user
  if [ -f "$DIR/.service" ]; then UNIT="$(cat "$DIR/.service")"
  else
    UNIT="actions.runner.${REPO/\//-}.$NAME.service"
    if [ "$DRY" = 1 ]; then echo "   would run: (in $DIR) ./svc.sh install $RUNNER_USER   # service $UNIT"
    else ( cd "$DIR" && ./svc.sh install "$RUNNER_USER" >/dev/null ); UNIT="$(cat "$DIR/.service")"; fi
  fi
  RESTART=0
  if [ -n "$CPUS" ] && pin_unit "$UNIT" && systemctl is-active --quiet "$UNIT" 2>/dev/null; then RESTART=1; fi
  if [ "$RESTART" = 1 ]; then
    echo "   $UNIT is running: restarting it so the CPUs apply (a job in progress on it fails)"
    act systemctl restart "$UNIT"
  elif [ "$DRY" = 1 ]; then echo "   would run: (in $DIR) ./svc.sh start"
  else ( cd "$DIR" && ./svc.sh start >/dev/null ); fi
  if [ "$DRY" = 0 ]; then
    systemctl is-active --quiet "$UNIT" && echo "   service $UNIT: active" || echo "   service $UNIT: NOT active" >&2
  fi
done

[ "$DRY" = 0 ] || { echo "== dry run done: nothing was changed"; exit 0; }
echo "== done: $COUNT instance(s) labelled $LABEL for $REPO${CPUS:+, on CPUs $CPUS}. Check them with:"
echo "   gh api repos/$REPO/actions/runners --jq '.runners[] | \"\\(.name) \\(.status) busy=\\(.busy)\"'"
