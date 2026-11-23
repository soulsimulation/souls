#!/usr/bin/env bash
# O16 (#2809): the gateway upgraded, then killed, under 1,000 scripted agents of the shared uneven shape. One world
# (`worldd gateway-link`), its gateway and one client per agent; the gateway is upgraded at 20 s and killed at 40 s.
# Prints each event's row and the intents' row. Runbook: v2/docs/runbook/gateway-upgrade.md. Never on a machine that
# serves worlds. Scratch goes to <repo>/.local/o16-run (override with O16_ROOT); O16_AGENTS sets the agents.
#
# --systemd (S1): the gateway runs as a `souls-gateway@o16` unit of the machine's real systemd, upgraded by
# gateway-upgrade.sh (`systemctl restart`) and killed by `systemctl kill -s KILL` (its Restart=always, RestartSec=1s
# brings it back). The user's manager by default (`systemctl --user`, which gateway-upgrade reaches through a
# `systemctl` on its PATH that adds --user); O16_SYSTEMD=system uses the system's, through sudo. Linux only.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
UNIT=souls-gateway@o16.service

# Called back by o16-run under --systemd: start, upgrade, kill or stop the unit.
if [[ -n "${O16_UNIT_ROOT:-}" ]]; then
  if [[ $O16_SYSTEMD == system ]]; then sctl=(sudo systemctl); else sctl=(systemctl --user); fi
  case "$1" in
    start) "${sctl[@]}" start "$UNIT" ;;
    upgrade)
      if [[ $O16_SYSTEMD == system ]]; then
        sudo env SOULS_LIB="$O16_UNIT_ROOT/lib" WORLDS_ROOT="$O16_UNIT_ROOT/worlds" bash "$HERE/gateway-upgrade.sh"
      else
        PATH="$O16_UNIT_ROOT/shim:$PATH" SOULS_LIB="$O16_UNIT_ROOT/lib" WORLDS_ROOT="$O16_UNIT_ROOT/worlds" \
          bash "$HERE/gateway-upgrade.sh"
      fi ;;
    kill) "${sctl[@]}" kill -s KILL "$UNIT" ;;
    stop) "${sctl[@]}" stop "$UNIT" ;;
    *) echo "o16-run.sh: unknown unit step $1" >&2; exit 2 ;;
  esac
  exit
fi

cd "$HERE/../.."
ROOT=${O16_ROOT:-../.local/o16-run}
AGENTS=${O16_AGENTS:-1000}
cargo build --release --locked --quiet -p ops -p worldd -p gatewayd
ulimit -n 8192
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
node tools/driver/loads.mjs target --agents "$AGENTS" --seconds 60 --seed 1 --out "$ROOT/schedule.txt"
if [[ "${1:-}" != --systemd ]]; then
  exec target/release/o16-run --dir "$ROOT/run" --schedule "$ROOT/schedule.txt"
fi

export O16_SYSTEMD=${O16_SYSTEMD:-user} O16_UNIT_ROOT=$ROOT
if [[ $O16_SYSTEMD == system ]]; then
  sctl=(sudo systemctl); units=/run/systemd/system; put=(sudo tee); user="User=$(id -un)"
else
  sctl=(systemctl --user); units=${XDG_RUNTIME_DIR:?the user manager needs XDG_RUNTIME_DIR}/systemd/user; put=(tee); user=
  mkdir -p "$ROOT/shim"
  printf '#!/bin/sh\nexec %s --user "$@"\n' "$(command -v systemctl)" > "$ROOT/shim/systemctl"
  chmod +x "$ROOT/shim/systemctl"
fi
# The install's layout in miniature: the build and gateway-upgrade in lib/, one world under worlds/worlds/.
mkdir -p "$ROOT/lib" "$ROOT/worlds/worlds/o16"
cp target/release/gatewayd target/release/gateway-upgrade "$ROOT/lib/"
port=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "GATEWAYD_ARGS=--listen 127.0.0.1:$port --world w.sock --tokens tokens --build 1220" > "$ROOT/gateway-o16.env"
cleanup() {
  "${sctl[@]}" stop "$UNIT" 2>/dev/null || true
  if [[ $O16_SYSTEMD == system ]]; then sudo rm -f "$units/souls-gateway@.service"; else rm -f "$units/souls-gateway@.service"; fi
  "${sctl[@]}" daemon-reload || true
}
trap cleanup EXIT
"${put[@]}" "$units/souls-gateway@.service" > /dev/null <<EOF
[Unit]
Description=Souls gateway for world %i (O16 run under systemd)

[Service]
$user
WorkingDirectory=$ROOT/run
EnvironmentFile=$ROOT/gateway-%i.env
ExecStart=$ROOT/lib/gatewayd \$GATEWAYD_ARGS
Restart=always
RestartSec=1s
LimitNOFILE=8192
EOF
"${sctl[@]}" daemon-reload
target/release/o16-run --dir "$ROOT/run" --schedule "$ROOT/schedule.txt" --unit "$HERE/o16-run.sh" \
  --listen "127.0.0.1:$port"
