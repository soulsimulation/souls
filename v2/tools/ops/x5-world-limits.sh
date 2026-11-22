#!/usr/bin/env bash
# #4013 follow-up (#1960): world-limits.json reaches systemd. Installs the repo's worldd@.service and souls.slice as
# user units, writes the limits drop-ins with world-limits.mjs from the repo's config and a test authority map (one
# world registered as eden, one small world), and prints what systemd loads for each. Starts nothing; removes all it
# made. Needs a Linux user manager (systemctl --user) and node.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
U=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
hex() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
EDEN=$(hex)-$(hex)-0 SMALL=$(hex)-$(hex)-0
T=$(mktemp -d)
cleanup() {
  rm -rf "$U/worldd@$EDEN.service.d" "$U/worldd@$SMALL.service.d" "$T"
  if [ "${INSTALLED:-0}" = 1 ]; then rm -f "$U/worldd@.service" "$U/souls.slice"; fi
  systemctl --user daemon-reload
}
trap cleanup EXIT
mkdir -p "$U"
for f in worldd@.service souls.slice; do [ ! -e "$U/$f" ] || { echo "x5-world-limits: $U/$f exists; refusing" >&2; exit 2; }; done
INSTALLED=1
cp "$HERE/units/worldd@.service" "$HERE/units/souls.slice" "$U/"
# Placed: place-world.sh made each world's drop-in folder.
mkdir -p "$U/worldd@$EDEN.service.d" "$U/worldd@$SMALL.service.d" "$T/etc/souls/placement-data" "$T/etc/systemd"
ln -s "$U" "$T/etc/systemd/system"
printf '{"format":"souls/world-authority/1","worlds":{"eden":{"instance":"%s"},"small":{"instance":"%s"}}}\n' "$EDEN" "$SMALL" \
  > "$T/etc/souls/placement-data/authority.json"
echo "plan:  $(node "$HERE/world-limits.mjs" plan --config "$HERE/units/world-limits.json" --root "$T" | sed "s/$EDEN/<eden>/")"
node "$HERE/world-limits.mjs" apply --config "$HERE/units/world-limits.json" --root "$T" > /dev/null
echo "again: $(node "$HERE/world-limits.mjs" plan --config "$HERE/units/world-limits.json" --root "$T" | wc -l) changes"
systemctl --user daemon-reload
show() { systemctl --user show -p MemoryMax -p Environment "$1" | tr '\n' ' ' | sed "s/WORLDS_ROOT=[^ ]* //"; }
printf '%-14s %s\n' "unit" "what systemd loads"
printf '%-14s %s\n' "eden world" "$(show "worldd@$EDEN.service")"
printf '%-14s %s\n' "small world" "$(show "worldd@$SMALL.service")"
printf '%-14s %s\n' "souls.slice" "$(systemctl --user show -p MemoryMax souls.slice)"
