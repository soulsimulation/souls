#!/usr/bin/env bash
# A throwaway machine in one folder, for proving release.sh (Engine v2 O18, #2811) with no production machine and no
# systemd: two Eden worlds seeded by `worldd seed`, placed as `place-world.sh` places them and served by `worldd
# serve` from their pins (C1, #3365; O18b, #3498), each with its gateway, and a `systemctl` that plays systemd's part
# (a unit is a loop that starts its program again 100 ms after it ends; `restart` ends it; `is-active` asks if it
# runs). Linux or macOS. Docs: v2/docs/release.md.
#
#   bash scratch.sh up <dir> <install bundle> <facts.json> <entries dir>
#                                                   the machine: lib (the install bundle's programs), data, etc, and
#                                                   two worlds seeded from the facts, on a served build
#   bash scratch.sh build <dir> <label> [plant|mute]  a world build (a script running the machine's `worldd`, or with
#                                                   `plant`, one that rehearses well and dies when served, or with
#                                                   `mute`, one that never serves); prints its file
#   bash scratch.sh ssh <dir> <command>             release.sh's transport (RELEASE_SSH="bash scratch.sh ssh",
#                                                   RELEASE_TARGET=<dir>): runs <command> on the machine
#   bash scratch.sh down <dir>                      ends every unit
#
# A world's socket is `data/run/<world>.sock` (WORLDD_SOCKET, as `place-world.sh` sets it), named from the machine's
# `data/worlds`, so its path stays under macOS's 104 bytes.
set -euo pipefail

die() {
  echo "scratch: $*" >&2
  exit 2
}

# The machine's environment: release.sh's (RELEASE_*) and the runbook wrappers' (SOULS_*) stand-ins for its folders.
machine_env() {
  local m=$1
  export RELEASE_DATA=$m/data RELEASE_LIB=$m/lib RELEASE_ETC=$m/etc WORLDS_ROOT=. SCRATCH=$m PATH=$m/shim:$PATH
  export SOULS_LIB=$m/lib SOULS_ETC=$m/etc
  export RELEASE_WINDOW_S=${RELEASE_WINDOW_S:-5}
  # It runs no directory and no origin, so the move restarts neither (release.test.mjs proves that step).
  export RELEASE_SERVICES=
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
    if [ "$mode" = plant ]; then
      # A fault only serving shows: the rehearsal passes, the served world dies at start.
      echo 'if [ "$1" = serve ] && [ -z "$WORLDD_REHEARSAL" ]; then echo "planted fault: dies when served" >&2; exit 1; fi'
    elif [ "$mode" = mute ]; then
      # A build that never answers: it starts and serves no socket, rehearsal or not.
      echo 'if [ "$1" = serve ]; then exec sleep 3600; fi'
    fi
    echo 'exec "'"$m"'/lib/worldd" "$@"'
  } > "$f"
  chmod 755 "$f"
  echo "$f"
}

up() {
  local m=$1 bundle=$2 facts=$3 entries=$4 b h i name seed
  [ ! -e "$m" ] || die "$m exists: a scratch machine starts empty"
  [ -f "$bundle/install.sh" ] && [ -f "$facts" ] && [ -d "$entries" ] || die "up <dir> <install bundle> <facts> <entries>"
  mkdir -p "$m"/{shim,units,lib,etc,seed,data/run,data/worlds/worlds}
  m=$(cd "$m" && pwd)
  # The install's programs, where `install.sh apply` puts them (/usr/local/lib/souls).
  for b in supervisor worldd gatewayd directoryd deploy gateway-upgrade; do install -m 755 "$bundle/bin/$b" "$m/lib/$b"; done
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
  b=$(build "$m" before)
  h=$("$m/lib/supervisor" hash "$b")
  mkdir -p "$m/data/worlds/builds/$h"
  install -m 755 "$b" "$m/data/worlds/builds/$h/worldd"
  for i in a b; do
    # Two worlds from one facts file: a facts file's `world` names its lineage (import-eden), so each is its own.
    seed=$m/seed/$i
    sed "1s/^{/{\"world\":\"eden-2026-scratch-$i\",/" "$facts" > "$m/seed/facts-$i.json"
    "$m/lib/worldd" seed --facts "$m/seed/facts-$i.json" --dir "$seed" --entries "$entries" --souls 1 > /dev/null
    name=$(sed -n 's/.*"name": *"\([0-9a-f-]*\)".*/\1/p' "$seed/world.json")
    # As place-world.sh places it: the folder, its socket under run/, its gateway on the folder's tokens.
    mkdir -p "$m/data/worlds/worlds/$name"
    (cd "$seed" && tar cf - .) | (cd "$m/data/worlds/worlds/$name" && tar xf -)
    (cd "$m/data/worlds" && WORLDS_ROOT=. "$m/lib/supervisor" pin "$name" "$h")
    (cd "$m/data/worlds" && unit "$m" "worldd@$name" env WORLDS_ROOT=. "WORLDD_SOCKET=../run/$name.sock" \
      "$m/lib/supervisor" launch "$name")
    (cd "$m/data/worlds" && unit "$m" "souls-gateway@$name" "$m/lib/gatewayd" --listen 127.0.0.1:0 \
      --world "../run/$name.sock" --tokens "worlds/$name/tokens" --build 1220 --entries "worlds/$name/entries")
    echo "scratch: Eden world $name seeded, pinned to ${h:0:16}… (before), its unit and gateway running"
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
