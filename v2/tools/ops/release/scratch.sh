#!/usr/bin/env bash
# A throwaway machine in one folder, for proving release.sh (Engine v2 O18, #2811) with no production machine and no
# systemd: two worlds started from their pins, each with its gateway, and a `systemctl` that plays systemd's part
# (a unit is a loop that starts its program again 100 ms after it ends; `restart` ends it; `is-active` asks if it
# runs). Linux or macOS. Docs: v2/docs/release.md.
#
#   bash scratch.sh up <dir> <cargo release dir>    the machine: data, lib, etc, two worlds on a served build
#   bash scratch.sh build <dir> <label> [plant]     a world build (a script serving `worldd gateway-link`, or with
#                                                   `plant`, o7-plant's refuse-every-act); prints its file
#   bash scratch.sh ssh <dir> <command>             release.sh's transport (RELEASE_SSH="bash scratch.sh ssh",
#                                                   RELEASE_TARGET=<dir>): runs <command> on the machine
#   bash scratch.sh down <dir>                      ends every unit
#
# Worlds served this way are I4's world (`worldd gateway-link`), as O7's run serves them: the launcher's own
# `worldd --dir` does not serve a probe yet (v2/docs/runbook/deploy-and-roll-back.md, Known limits).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

die() {
  echo "scratch: $*" >&2
  exit 2
}

# The machine's environment. Paths under w/ are relative, so a world's socket path stays under macOS's 104 bytes.
machine_env() {
  local m=$1
  export RELEASE_DATA=$m/data RELEASE_LIB=$m/lib RELEASE_ETC=$m/etc WORLDS_ROOT=. SCRATCH=$m PATH=$m/shim:$PATH
  export RELEASE_WINDOW_S=${RELEASE_WINDOW_S:-5}
  cd "$m/data/worlds"
}

# unit <name> <command...>: the loop systemd would run.
unit() {
  local m=$1 name=$2
  shift 2
  nohup bash -c '
    m=$1 name=$2; shift 2
    while [ ! -f "$m/down" ]; do
      "$@" >> "$m/units/$name.out" 2>&1 &
      echo $! > "$m/units/$name.pid"
      wait $! || true
      sleep 0.1
    done' _ "$m" "$name" "$@" > /dev/null 2>&1 &
  echo $! > "$m/units/$name.loop"
}

build() {
  local m=$1 label=$2 mode=${3:-} f
  f=$m/builds-in/$label
  mkdir -p "$m/builds-in"
  {
    echo '#!/bin/sh'
    echo "# scratch build: $label"
    echo 'if [ "$1" = --dir ]; then'
    # A world's lineage is its folder's name's first part; a rehearsal's folder is named by the build, and its log
    # names no lineage, so a rehearsal serves the first world's.
    echo '  l=$(basename "$2"); case $l in *-*) l=${l%%-*} ;; *) l=$(printf "07%.0s" $(seq 16)) ;; esac; cd "$2" || exit 1'
    if [ "$mode" = plant ]; then
      echo '  [ -n "$WORLDD_REHEARSAL" ] && exec "'"$m"'/bin/worldd" gateway-link --socket w.sock --lineage "$l" --epoch 1 --log world.log --bodies 1'
      echo '  exec "'"$m"'/bin/o7-plant" refuse . "$l" 1'
    else
      echo '  exec "'"$m"'/bin/worldd" gateway-link --socket w.sock --lineage "$l" --epoch 1 --log world.log --bodies 1'
    fi
    echo 'fi'
    echo 'exec "'"$m"'/bin/worldd" "$@"'
  } > "$f"
  chmod 755 "$f"
  echo "$f"
}

up() {
  local m=$1 bins=$2 b h w l name
  [ ! -e "$m" ] || die "$m exists: a scratch machine starts empty"
  mkdir -p "$m"/{bin,shim,units,lib,etc/probe,data/worlds/worlds}
  m=$(cd "$m" && pwd)
  for b in worldd gatewayd supervisor o7-plant o18-probe; do install -m 755 "$bins/$b" "$m/bin/$b"; done
  install -m 755 "$bins/gatewayd" "$m/lib/gatewayd"
  cat > "$m/shim/systemctl" << 'EOF'
#!/usr/bin/env bash
# systemd's part on the scratch machine: restart [--no-block] <unit> and is-active [--quiet] <unit>.
u=
for a in "$@"; do case $a in *.service) u=${a%.service} ;; esac; done
pid=$(cat "$SCRATCH/units/$u.pid" 2> /dev/null || true)
echo "$(date -u +%T) systemctl $*" >> "$SCRATCH/units/systemctl.log"
case $1 in
  restart) [ -z "$pid" ] || kill "$pid" 2> /dev/null || true ;;
  is-active) [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null ;;
  *) exit 1 ;;
esac
EOF
  chmod 755 "$m/shim/systemctl"
  : > "$m/tokens"
  b=$(build "$m" before)
  h=$(cd "$m" && "$m/bin/supervisor" hash "$b")
  mkdir -p "$m/data/worlds/builds/$h"
  install -m 755 "$b" "$m/data/worlds/builds/$h/worldd"
  for l in 07 08; do
    l=$(printf "$l%.0s" $(seq 16))
    name=$("$m/bin/o18-probe" "$m/etc/probe/tmp" "$l")
    mv "$m/etc/probe/tmp" "$m/etc/probe/$name"
    mkdir -p "$m/data/worlds/worlds/$name"
    (cd "$m/data/worlds" && WORLDS_ROOT=. "$m/bin/supervisor" pin "$name" "$h")
    (cd "$m/data/worlds" && unit "$m" "worldd@$name" env WORLDS_ROOT=. "$m/bin/supervisor" launch "$name")
    (cd "$m/data/worlds" && unit "$m" "souls-gateway@$name" "$m/lib/gatewayd" --listen 127.0.0.1:0 \
      --world "worlds/$name/w.sock" --tokens "$m/tokens" --build 1220)
    echo "scratch: world $name pinned to ${h:0:16}… (before), its unit and gateway running"
  done
}

ssh_() {
  local m=$1
  shift
  (machine_env "$(cd "$m" && pwd)" && bash -c "$*")
}

down() {
  local m=$1 f
  touch "$m/down"
  for f in "$m"/units/*.loop "$m"/units/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2> /dev/null || true; done
  echo "scratch: down"
}

cmd=${1:-}
shift || true
case $cmd in
  up) up "$@" ;;
  build) build "$(cd "$1" && pwd)" "${@:2}" ;;
  ssh) ssh_ "$@" ;;
  down) down "$@" ;;
  *) die "up|build|ssh|down (see the top of $0)" ;;
esac
