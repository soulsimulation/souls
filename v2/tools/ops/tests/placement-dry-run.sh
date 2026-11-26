#!/usr/bin/env bash
# release.sh placement's dry run (New world on each release's build, #5047, #5051): a machine in one folder under
# .local/, its library holding a previous worldd, ops/ and pin and two templates published by this checkout's `worldd
# seed` and `publish-template` from a rack bay and an upright (import-eden's joining fixture: the kinds 0.142's Mars
# camp template was refused on), and a release staged with this checkout's worldd and publish-template. Then
# `release.sh placement <sha> check` and `run` as a release runs them on the host (no directory here), and a fork of
# each swapped-in template by the library's worldd, as the placement initializer makes one. Never touches a production
# machine.
#
#   bash v2/tools/ops/tests/placement-dry-run.sh [--keep]
#
# Needs the builds (from v2/): cargo build -p worldd -p templates (PROFILE=release for target/release). Exit 0 when
# every step comes out as it should.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../../.." && pwd)
t=${CARGO_TARGET_DIR:-$repo/v2/target}/${PROFILE:-debug}
for b in worldd templates; do [ -x "$t/$b" ] || {
  echo "dry run: no $t/$b (see the top of $0)" >&2
  exit 2
}; done
mkdir -p "$repo/.local"
D=$(mktemp -d "$repo/.local/placement-XXXXXX")
D=$(cd "$D" && pwd)
KEEP=${1:-}
trap 'if [ "$KEEP" = --keep ]; then echo "kept $D"; else rm -rf "$D"; fi' EXIT
pass=0 fail=0
ok() { echo "PASS: $*" && pass=$((pass + 1)); }
no() { echo "FAIL: $*" && fail=$((fail + 1)); }
pin() { if command -v sha256sum > /dev/null; then echo "1220$(sha256sum "$1" | cut -c1-64)"; else echo "1220$(shasum -a 256 "$1" | cut -c1-64)"; fi; }
release=$repo/v2/tools/ops/release/release.sh
sha=$(printf 'e%.0s' $(seq 40))
data=$D/data lib=$D/lib etc=$D/etc tpl=$D/lib/templates
mkdir -p "$data/worlds/worlds" "$etc" "$tpl" "$lib/ops" "$D/fixture/entries"

# The fixture: #5047's facts and the construction kinds and the body, as the repository has them.
cat > "$D/fixture/facts.json" << 'EOF'
{"format": "souls/import-eden/1",
 "kinds": [{"ref": "t-bay@1", "hash": "aa", "name": "mars:rack_bay", "form": "point"},
           {"ref": "t-upright@1", "hash": "bb", "name": "mars:rack_upright", "form": "point"}],
 "things": [{"id": "e_bay", "def": "t-bay@1", "ref": "t-bay@1", "parent": null, "pose": [0, 0, 0, 0], "world": [0, 0, 0, 0], "scale_ppm": 1000000},
            {"id": "e_upright", "def": "t-upright@1", "ref": "t-upright@1", "parent": null, "pose": [3000, 0, 0, 0], "world": [3000, 0, 0, 0], "scale_ppm": 1000000}],
 "doors": [], "places": [],
 "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
 "bake": {"things": 2}, "byRef": {"t-bay@1": 1, "t-upright@1": 1}}
EOF
cp "$repo"/content/kinds/construction/*.json "$D/fixture/entries/"
cp "$repo/content/kinds/body/humanoid.json" "$D/fixture/entries/"

# The library as an earlier release left it: a previous worldd (pinned), ops/ and two published templates.
printf '#!/bin/sh\n# the previous worldd\n' > "$lib/worldd" && chmod 755 "$lib/worldd"
echo '// the previous' > "$lib/ops/place-created-world.mjs"
for n in yard camp; do
  "$t/worldd" seed --facts "$D/fixture/facts.json" --entries "$D/fixture/entries" --souls 0 --at 3.123,-2.5 --dir "$D/support-$n" > /dev/null
  "$t/templates" "$D/fixture/facts.json" "$D/published" --name "$n" --support "$D/support-$n" > /dev/null
  mv "$D/published/$n" "$tpl/$n"
  cp -R "$tpl/$n" "$D/before-$n"
done
old=$(pin "$lib/worldd")
printf '{"format":"souls/placement/1","build":"%s","worldsRoot":"%s","templates":"%s","library":"%s"}\n' "$old" "$data/worlds" "$tpl" "$lib" > "$etc/placement.json"

# The release, staged as `stage` leaves it: its worldd by hash, its publish-template and ops/ in its record.
h=$(pin "$t/worldd")
mkdir -p "$data/worlds/builds/$h" "$data/releases/$sha/bin" "$data/releases/$sha/moved"
cp "$t/worldd" "$data/worlds/builds/$h/worldd"
cp "$t/templates" "$data/releases/$sha/bin/templates"
bash "$repo/v2/tools/ops/install.sh" ops "$data/releases/$sha/ops"
printf '{"commit":"%s","version":"0.0.0","artifacts":[\n{"name":"worldd","hash":"%s","bytes":1}\n]}\n' "$sha" "$h" > "$data/releases/$sha/manifest.json"
# No unit of this machine is ever asked or stopped: a systemctl that finds nothing running.
mkdir -p "$D/shim" && printf '#!/bin/sh\nexit 3\n' > "$D/shim/systemctl" && chmod 755 "$D/shim/systemctl"
export PATH=$D/shim:$PATH RELEASE_DATA=$data WORLDS_ROOT=$data/worlds RELEASE_ETC=$etc RELEASE_LIB=$lib RELEASE_SERVICES=

echo "== placement check"
bash "$release" placement "$sha" check | tee "$D/check.txt" || true
[ "$(grep -c 'republished and dry-run forked: fork: lineage' "$D/check.txt")" = 2 ] && ok "check: both templates republished and dry-run forked" || no "check: $(tail -1 "$D/check.txt")"
[ "$(pin "$lib/worldd")" = "$old" ] && grep -q "\"build\":\"$old\"" "$etc/placement.json" && diff -rq "$tpl/yard" "$D/before-yard" > /dev/null &&
  diff -rq "$tpl/camp" "$D/before-camp" > /dev/null && [ ! -e "$lib/.templates.next" ] && ok "check: nothing changed" || no "check changed something"

echo "== placement run"
bash "$release" placement "$sha" run | tee "$D/run.txt" || true
[ "$(pin "$lib/worldd")" = "$h" ] && grep -q '# the previous worldd' "$lib/.worldd.prev" && ok "the library's worldd is the release's, the previous beside it" || no "worldd"
grep -q "\"build\":\"$h\"" "$etc/placement.json" && ok "the pin is the release's worldd" || no "pin"
cmp -s "$repo/v2/tools/ops/place-created-world.mjs" "$lib/ops/place-created-world.mjs" && [ -f "$lib/.ops.prev/place-created-world.mjs" ] &&
  ok "ops/ is the release's, the previous beside it" || no "ops"
[ "$(ls -A "$tpl" | tr '\n' ' ')" = ".aside camp yard " ] && [ ! -e "$lib/.templates.next" ] && ok "the catalogue holds the two templates and .aside, nothing stray" || no "catalogue: $(ls -A "$tpl")"
for n in yard camp; do
  diff -rq "$tpl/.aside/$n" "$D/before-$n" > /dev/null && ok "$n: the previous kept in .aside" || no "$n: .aside"
  cmp -s "$tpl/$n/template" "$D/before-$n/template" && no "$n: not republished" || ok "$n: republished (a new sealed manifest)"
  for f in facts.json entry.json; do cmp -s "$tpl/$n/$f" "$D/before-$n/$f" && ok "$n: $f carried exactly" || no "$n: $f differs"; done
  diff -rq "$tpl/$n/entries" "$D/before-$n/entries" > /dev/null && ok "$n: entries carried exactly" || no "$n: entries differ"
  if "$lib/worldd" fork --from "$tpl/$n/ckpt" --template "$tpl/$n" --to "$D/made-$n" --through dddddddddddddddddddddddddddddddd:2 > "$D/fork-$n.txt" 2>&1; then
    ok "$n: the library's worldd forks it where it stands: $(grep -m1 '^fork:' "$D/fork-$n.txt")"
  else no "$n: fork: $(tail -1 "$D/fork-$n.txt")"; fi
done
bash "$release" placement "$sha" run | grep -q 'already done by this release' && ok "a second run does nothing" || no "second run"
echo "dry run: $pass passed, $fail failed"
[ "$fail" = 0 ]
