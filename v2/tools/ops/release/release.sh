#!/usr/bin/env bash
# One release of Engine v2 is one commit (Engine v2 O18, #2811): built once, staged by hash, moved by canary, rolled
# back by a workflow. `.github/workflows/release-v2.yml` and `rollback-v2.yml` run it; docs: v2/docs/release.md.
#
# On the runner:
#   bash release.sh checks <sha>                       refuses `release.missing-check: <name>` for each check of
#                                                      v2/docs/release.md's list the head has not passed (gh api); the
#                                                      merge queue's green `ci` run at <sha> counts for its CI checks
#   bash release.sh bundle <out> <sha> <version> <cargo release dir> <page dist dir> <client dir> [<wasm pkg dir>]
#                                                      the artifacts, the tools and manifest.json (name, hash);
#                                                      client.tar is the served client (v2/client/served/build.mjs,
#                                                      R17 #2818), each served file a `served` line of the manifest;
#                                                      directoryd, origin.tar (install.sh origin) and units.tar (their
#                                                      two unit files) are the directory and the viewers' origin;
#                                                      reseed/ holds Eden's reseed, its undo, content/kinds and
#                                                      Eden's stock with its libraries (reseed/stock, #4837); ops/
#                                                      the placement scripts (install.sh ops), for `placement`
#   bash release.sh publish <version> <sha> <date>     in a checkout of main: the tag, the GitHub Release and the
#                                                      changelog pull request, each only if it is not there yet
#   RELEASE_TARGET=<ssh target> bash release.sh remote stage <bundle>
#   RELEASE_TARGET=<ssh target> bash release.sh remote <command> [args]   runs this file's <command> on the machine
# On the machine (as root):
#   stage <bundle>                 each artifact to $WORLDS_ROOT/builds/<hash>/<name> if its bytes hash to the
#                                  manifest's; the release's record to $DATA/releases/<sha>/; then verify
#   verify <sha>                   the staged files' hashes against the manifest's, as a table
#   move <sha> [<canary world>|@eden]   the canary's pin by `deploy` (O7), then every other world's, then the gateway by
#                                  `gateway-upgrade` (O16), then the page, then the served client
#                                  ($LIB/client, which a world's address serves), then the directory (souls-directory)
#                                  and the viewers' origin (souls-origin), each restarted once on the release's program
#                                  and unit and checked healthy, else put back on its previous ones; each step done
#                                  once per release. Before the deploys, `bodies worlds`; after the page, `bodies binding`.
#                                  Just before each world's deploy, `entries stage` for that world: its deploy rehearses
#                                  the new build on them and swaps them in between the pin and the restart, so only the
#                                  new build reads them (supervisor deploy.rs); a failed deploy leaves none staged
#   entries plan|stage <sha> [<world>...]   each world's library entries (<world>/entries, which worldd reads at
#                                  start and a seed wrote once) brought up to this release's (reseed/kinds: content/kinds
#                                  at its commit) by this release's `worldd entries`, every world when none is named:
#                                  plan lists per world which entries change or are added, and which is refused and why,
#                                  changing nothing; stage writes them as <world>/entries.next, never entries/ itself.
#                                  A refused world, a fork (its boot pins its entries) and a world with none keep theirs
#   bodies worlds <page.tar> [<world>...]   the page's body catalogue (assets/bodies/bodies.json) into each world's
#                                  folder (every world when none is named) that has none, or whose own it admits
#                                  every body of; a fork keeps its own (its boot pins it). worldd reads it at start
#   bodies binding                 each world of the launcher's cutover binding (SOULS_CUTOVER_BINDING, else
#                                  $ETC/cutover-binding.json, as the launcher finds it) that names no catalogue gets
#                                  bodiesDir $LIB/web/assets/bodies: its page draws the bodies Souls wear, served at
#                                  /w/<slug>/v2/bodies/ (the launcher reads the file again within a second)
#   mailbox plan|apply|check       the owner's messages (R13): plan prints what apply would change (the mailbox key,
#                                  made once, 0600; `--mailbox-key` in directory.args; `--mailbox <directory>
#                                  --mailbox-key` in each gateway-<world>.env), apply changes it; check sends one
#                                  owner's message for a grant no Soul holds through each world's gateway and wants it
#                                  accepted. move applies before the gateways restart and checks after the directory
#   rollback <to> <from> <world>...   `deploy rollback`: refuses unless each world is pinned to <from>, and a world on
#                                  a store generation (#4954) unless <to> reads it
#   reseed <sha> check|run [<label>]   Eden fresh on this release's build (reseed/reseed-eden.sh with this release's
#                                  world-aside and kinds); with <label>, resumes that reseed. check changes nothing
#   reseed-undo <label> check|run  undoes that reseed, with the undo the release it moved to carried
#   placement <sha> check|run      New world on this release's build ($ETC/placement.json; with none, nothing to do):
#                                  each template of the catalogue (a folder with a `template` file) seeded, published
#                                  by the release's publish-template and dry-run forked by its worldd, in a folder
#                                  beside the catalogue; check stops there and changes nothing. run then renames into
#                                  place the library's worldd and ops/ (the previous: .worldd.prev, .ops.prev), the pin
#                                  (.placement.json.prev) and each template (templates/.aside/<name>), and restarts the
#                                  directory when the catalogue it reads changed; if it is then unhealthy, all of it
#                                  goes back. A failure before the renames changes nothing: the previous templates stay
#   news <sha> <version> <link> <date>   one release entry in $DATA/news.jsonl, keyed by its link; refuses
#                                  `release.not-live` unless this release moved every world
# A refusal prints `refused: <name>: <why>` and exits 3; it changes nothing it has not already done.
set -euo pipefail

DATA=${RELEASE_DATA:-/var/lib/souls}
WORLDS_ROOT=${WORLDS_ROOT:-$DATA/worlds}
LIB=${RELEASE_LIB:-/usr/local/lib/souls}
ETC=${RELEASE_ETC:-/etc/souls}
UNITS=${RELEASE_UNITS:-/etc/systemd/system}
export WORLDS_ROOT
# The artifacts of a release, by their names under builds/<hash>/; worldd's hash is its build (O1, O7). directoryd,
# origin.tar and units.tar (souls-directory.service, souls-origin.service) are the directory and the viewers' origin.
ARTIFACTS=(worldd gatewayd page.tar client.tar directoryd origin.tar units.tar)
# The two services the move restarts after the worlds and the gateway; the scratch machine runs neither (scratch.sh).
SERVICES=${RELEASE_SERVICES-directory origin}
# What moves them, carried with the release; world-aside sets a world's store objects aside for a reseed (0.133 R13);
# assets-check, the gateway's uploads checker (#1960), goes in beside the gateway when the gateway moves; store-copy is
# store-switch.sh's copy tool (v2/docs/runbook/store-switch.md), carried so the host need not build it; templates is
# publish-template, which `placement` republishes the catalogue's templates with.
TOOLS=(deploy gateway-upgrade world-aside assets-check store-copy templates)
# A reseed of Eden, carried under reseed/ with the kinds it seeds from (content/kinds at the release's commit) and its
# stock (reseed/stock: content/worlds/eden/stock.json and content/library/, #4837).
RESEED=(reseed-eden.sh reseed-eden-undo.sh)

die() {
  echo "release: $*" >&2
  exit 2
}
refuse() {
  echo "refused: $*"
  exit 3
}

# A file's hash as O1 names a build: the SHA-256 multihash, `1220` and 64 hex.
hash() {
  local s
  if command -v sha256sum > /dev/null; then s=$(sha256sum "$1"); else s=$(shasum -a 256 "$1"); fi
  echo "1220${s:0:64}"
}

# The manifest's artifacts, one `<name> <hash> <bytes>` line each (bundle writes one artifact per line).
entries() { sed -n 's/^{"name":"\([^"]*\)","hash":"\(1220[0-9a-f]\{64\}\)","bytes":\([0-9]*\)}.*/\1 \2 \3/p' "$1"; }
field() { sed -n "s/.*\"$2\":\"\\([^\"]*\\)\".*/\\1/p" "$1" | head -1; }
artifact() { entries "$1" | awk -v n="$2" '$1 == n {print $2}'; }

# A4: every check v2/docs/release.md lists (between its release-checks markers) passed at <sha>: a run of that name
# concluded success there. 0.133 R13: for `ci-ok` and the v2 legs, so does the merge queue's `ci` run concluding
# success at <sha> (a queued commit lands on main as itself): a pull request enters the queue only with ci-ok green at
# its own head, which needs every v2 leg its paths select, and the queue's run checks that the combined code
# compiles. Main's own push run is often cancelled by the next merge, and runs no leg its paths do not select.
checks() {
  local sha=$1 doc=${RELEASE_DOC:-$(dirname "$0")/../../../docs/release.md} names passed n queued missing=()
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "checks <full 40-hex sha>"
  names=$(sed -n '/<!-- release-checks -->/,/<!-- \/release-checks -->/s/^- `\([^`]*\)`.*/\1/p' "$doc")
  [ -n "$names" ] || die "no checks listed in $doc"
  passed=$(gh api --paginate "repos/${GITHUB_REPOSITORY:?}/commits/$sha/check-runs?per_page=100" --jq \
    '.check_runs[] | select(.conclusion == "success") | .name' | sort -u)
  queued=$(gh api "repos/${GITHUB_REPOSITORY:?}/actions/runs?head_sha=$sha&event=merge_group&per_page=100" --jq \
    '[.workflow_runs[] | select(.name == "ci" and .conclusion == "success")] | length')
  if [ "${queued:-0}" -gt 0 ]; then
    echo "checks: the merge queue's ci run passed at ${sha:0:12}, so ci-ok and the v2 legs count as passed"
    passed=$(printf '%s\n' "$passed" "$(grep -xE 'ci-ok|v2-.+' <<< "$names")" | sort -u)
  fi
  while IFS= read -r n; do
    grep -qxF -- "$n" <<< "$passed" || missing+=("$n")
  done <<< "$names"
  if [ ${#missing[@]} -gt 0 ]; then
    for n in "${missing[@]}"; do echo "refused: release.missing-check: $n has not passed at ${sha:0:12}"; done
    exit 3
  fi
  echo "checks: every listed check passed at ${sha:0:12}: $(tr '\n' ' ' <<< "$names")"
}

bundle() {
  local out=$1 sha=$2 version=$3 bins=$4 page=$5 client=$6 pkg=${7:-$6/../target/wasm-load/pkg} a t lines=() served=()
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "bundle: the sha is the full 40 hex"
  # X2: the page folder is the body files (bodies.ts) or a page build
  [ -f "$page/index.html" ] || [ -f "$page/assets/bodies/bodies.json" ] || die "bundle: no page folder at $page"
  [ -d "$client/src" ] && [ -d "$client/skill" ] || die "bundle: no client (src, skill) at $client"
  rm -rf "$out"
  mkdir -p "$out/artifacts" "$out/bin"
  install -m 755 "$bins/worldd" "$out/artifacts/worldd"
  install -m 755 "$bins/gatewayd" "$out/artifacts/gatewayd"
  install -m 755 "$bins/directoryd" "$out/artifacts/directoryd"
  # The origin's files as the install puts them (install.sh origin), and the two services' unit files.
  bash "$(dirname "$0")/../install.sh" origin "$out/origin"
  COPYFILE_DISABLE=1 tar -C "$out/origin" -cf "$out/artifacts/origin.tar" .
  mkdir -p "$out/units"
  cp "$(dirname "$0")/../units/souls-directory.service" "$(dirname "$0")/../units/souls-origin.service" "$out/units/"
  COPYFILE_DISABLE=1 tar -C "$out/units" -cf "$out/artifacts/units.tar" .
  rm -rf "$out/origin" "$out/units"
  COPYFILE_DISABLE=1 tar -C "$page" -cf "$out/artifacts/page.tar" .
  # The served client (R17): its files by name, version, length and hash, as soul-client.json gives them. Its version
  # is x.y.z (build.mjs), so a minor release's (0.132) is stamped 0.132.0; a patch's (0.131.1) is its own.
  local stamp=$version
  if [[ $version =~ ^[0-9]+\.[0-9]+$ ]]; then stamp=$version.0; fi
  node "$client/served/build.mjs" --out "$out/served" --version "$stamp" --pkg "$pkg" --commit "$sha" > /dev/null
  COPYFILE_DISABLE=1 tar -C "$out/served" -cf "$out/artifacts/client.tar" .
  for t in "$out"/served/*; do
    [ "${t##*/}" = soul-client.json ] && continue
    served+=("$(printf '{"served":"%s","version":"%s","hash":"%s","bytes":%s}' "${t##*/}" "$stamp" "$(hash "$t")" "$(wc -c < "$t" | tr -d ' ')")")
  done
  rm -rf "$out/served"
  for t in "${TOOLS[@]}"; do install -m 755 "$bins/$t" "$out/bin/$t"; done
  install -m 755 "$0" "$out/release.sh"
  bash "$(dirname "$0")/../install.sh" ops "$out/ops"
  mkdir -p "$out/reseed"
  for t in "${RESEED[@]}"; do install -m 755 "$(dirname "$0")/../cutover/$t" "$out/reseed/$t"; done
  cp -R "$(dirname "$0")/../../../../content/kinds" "$out/reseed/kinds"
  # Eden's stock and the libraries it draws (#4837), as a world folder keeps them: reseed-eden.sh seeds with them.
  mkdir -p "$out/reseed/stock/library"
  cp "$(dirname "$0")/../../../../content/worlds/eden/stock.json" "$out/reseed/stock/stock.json"
  cp "$(dirname "$0")/../../../../content/library/"*.json "$out/reseed/stock/library/"
  for a in "${ARTIFACTS[@]}"; do
    lines+=("$(printf '{"name":"%s","hash":"%s","bytes":%s}' "$a" "$(hash "$out/artifacts/$a")" "$(wc -c < "$out/artifacts/$a" | tr -d ' ')")")
  done
  # one artifact per line, as `entries` reads it
  {
    printf '{"commit":"%s","version":"%s","artifacts":[\n' "$sha" "$version"
    printf '%s\n' "${lines[@]}" | sed '$!s/$/,/'
    printf '],"served":[\n'
    printf '%s\n' "${served[@]}" | sed '$!s/$/,/'
    printf ']}\n'
  } > "$out/manifest.json"
  echo "bundle: ${#ARTIFACTS[@]} artifacts at ${sha:0:12}"
  entries "$out/manifest.json" | awk '{printf "  %-11s %s  %s bytes\n", $1, $2, $3}'
}

verify() {
  local rel=$DATA/releases/$1 name h n got bad=0
  [ -f "$rel/manifest.json" ] || refuse "release.not-staged: $1"
  printf '| artifact | manifest hash | staged file | its hash | equal |\n|---|---|---|---|---|\n'
  while read -r name h n; do
    got=missing
    [ -f "$WORLDS_ROOT/builds/$h/$name" ] && got=$(hash "$WORLDS_ROOT/builds/$h/$name")
    printf '| %s | %s | builds/%s…/%s | %s | %s |\n' "$name" "$h" "${h:0:16}" "$name" "$got" "$([ "$got" = "$h" ] && echo yes || echo NO)"
    [ "$got" = "$h" ] || bad=1
  done < <(entries "$rel/manifest.json")
  [ "$bad" = 0 ] || refuse "release.staged-mismatch: a staged file is not what the manifest names"
}

stage() {
  local from=$1 sha name h n d rel
  [ -f "$from/manifest.json" ] || die "stage: $from is not a bundle"
  sha=$(field "$from/manifest.json" commit)
  [ "$(entries "$from/manifest.json" | wc -l | tr -d ' ')" = "${#ARTIFACTS[@]}" ] || refuse "release.manifest: not ${#ARTIFACTS[@]} artifacts"
  # Nothing is written unless every artifact's bytes are the manifest's.
  while read -r name h n; do
    [ "$(hash "$from/artifacts/$name")" = "$h" ] || refuse "release.hash-mismatch: $name is not $h"
  done < <(entries "$from/manifest.json")
  # A binary built against a newer system library than this machine's will not start: find out before any pin moves.
  "$from/artifacts/worldd" schemas > /dev/null 2>&1 || refuse "release.will-not-start: worldd schemas fails on this machine"
  while read -r name h n; do
    d=$WORLDS_ROOT/builds/$h
    if [ -f "$d/$name" ] && [ "$(hash "$d/$name")" = "$h" ]; then
      echo "stage: $name already at builds/${h:0:16}…"
      continue
    fi
    mkdir -p "$d"
    install -m 755 "$from/artifacts/$name" "$d/.$name.new"
    mv "$d/.$name.new" "$d/$name"
    echo "stage: $name to builds/${h:0:16}…"
  done < <(entries "$from/manifest.json")
  rel=$DATA/releases/$sha
  mkdir -p "$rel/bin" "$rel/moved"
  install -m 644 "$from/manifest.json" "$rel/manifest.json"
  install -m 755 "$from/release.sh" "$rel/release.sh"
  for n in "${TOOLS[@]}"; do install -m 755 "$from/bin/$n" "$rel/bin/$n"; done
  rm -rf "$rel/reseed" "$rel/ops"
  cp -R "$from/reseed" "$rel/reseed"
  cp -R "$from/ops" "$rel/ops"
  verify "$sha"
}

worlds() { find "$WORLDS_ROOT/worlds" -mindepth 1 -maxdepth 1 -type d 2> /dev/null | sed 's|.*/||' | sort; }
# The directory's store for deploy's pins: the one worldd@'s launcher reads (#1960 B6). The install's drop-in gives
# worldd@ the secrets file after the unit's directory.env, so its store settings (only those) come from there and win,
# as systemd reads them (0.133 ST2: the store is set in secrets.env only).
directory_env() {
  local k v
  if [ -f "$ETC/directory.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ETC/directory.env"
    set +a
  fi
  if [ -r "$ETC/secrets.env" ]; then
    while IFS='=' read -r k v; do
      k=${k#export }
      case $k in
        DIRECTORY_STORE_* | AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_DEFAULT_REGION)
          v=${v%\"} v=${v#\"} v=${v%\'} v=${v#\'}
          export "$k=$v"
          ;;
      esac
    done < "$ETC/secrets.env"
  fi
}

# The body catalogue (souls/bodies/1) a release's page carries (bodies.ts) is the one every world admits: a Soul's
# `wear` is refused by a world without it, and a page whose binding names none draws every body as a default person.
# ADMITS <old> <new>: exits 0 when <new> is a catalogue that admits every body <old> does (or <old> is none).
ADMITS='const fs = require("fs"), cat = (f) => { try { const c = JSON.parse(fs.readFileSync(f, "utf8")); return c && c.format === "souls/bodies/1" && Array.isArray(c.bodies) ? new Set(c.bodies.map((b) => b && b.hash)) : null; } catch { return null; } };
const [o, n] = process.argv.slice(1).map(cat); process.exit(n && (!o || [...o].every((h) => n.has(h))) ? 0 : 1);'
# BIND <binding> <dir>: bodiesDir <dir> on each world of the binding that names no catalogue (bodiesDir or v2Bodies).
BIND='const fs = require("fs"), [file, dir] = process.argv.slice(1), b = JSON.parse(fs.readFileSync(file, "utf8"));
const list = Array.isArray(b.worlds) ? b.worlds : [b], set = list.filter((w) => w && typeof w === "object" && !w.bodiesDir && !w.v2Bodies);
for (const w of set) w.bodiesDir = dir;
if (set.length) { const st = fs.statSync(file), tmp = `${file}.bodies.new`; fs.writeFileSync(tmp, JSON.stringify(b, null, 2) + "\n", { mode: st.mode & 0o777 });
  if (process.getuid() === 0) fs.chownSync(tmp, st.uid, st.gid); fs.renameSync(tmp, file); }
console.log(`bodies: the binding serves ${dir} for ${set.length ? set.map((w) => w.canonicalSlug).join(", ") : "no other world"}; ${list.length - set.length} already named a catalogue`);'

bodies_worlds() {
  local tarball=$1 tmp new f w
  shift
  # shellcheck disable=SC2046 # a world's name is one word
  if [ $# -eq 0 ]; then set -- $(worlds); fi
  tmp=$(mktemp -d)
  tar -xf "$tarball" -C "$tmp" ./assets/bodies/bodies.json 2> /dev/null || tar -xf "$tarball" -C "$tmp" assets/bodies/bodies.json 2> /dev/null || true
  new=$tmp/assets/bodies/bodies.json
  if ! node -e "$ADMITS" "$new" "$new"; then
    rm -rf "$tmp"
    echo "bodies: this release's page carries no body catalogue; every world keeps its own"
    return 0
  fi
  for w in "$@"; do
    f=$WORLDS_ROOT/worlds/$w
    if grep -q '"fork" *: *true' "$f/world.json" 2> /dev/null; then
      echo "bodies: $w keeps its own catalogue (a fork's boot pins it)"
    elif [ -f "$f/bodies.json" ] && cmp -s "$new" "$f/bodies.json"; then
      echo "bodies: $w has this release's catalogue"
    elif [ -f "$f/bodies.json" ] && ! node -e "$ADMITS" "$f/bodies.json" "$new"; then
      echo "bodies: $w keeps its own catalogue (this release's does not admit every body it does)"
    else
      install -m 644 "$new" "$f/.bodies.json.new"
      if [ "$(id -u)" = 0 ]; then chown --reference="$f/world.json" "$f/.bodies.json.new"; fi
      mv "$f/.bodies.json.new" "$f/bodies.json"
      echo "bodies: $w gets this release's catalogue (read when its deploy restarts it)"
    fi
  done
  rm -rf "$tmp"
}

# One world's `worldd entries <plan|stage>`, by this release's worldd on this release's kinds; its status (3: refused).
# A stage writes <world>/entries.next only; the world's deploy swaps it in (or a stage that finds nothing removes it).
entries_world() {
  local act=$1 rel=$2 w=$3 f=$WORLDS_ROOT/worlds/$3 bin out s=0
  bin=$WORLDS_ROOT/builds/$(artifact "$rel/manifest.json" worldd)/worldd
  if [ ! -d "$f/entries" ] || [ ! -d "$rel/reseed/kinds" ]; then
    [ "$act" != stage ] || rm -rf "$f/entries.next"
    if [ ! -d "$f/entries" ]; then echo "entries: $w: kept: no entries"; else echo "entries: $w: kept: this release carries no kinds (staged by an older release-v2)"; fi
    return 0
  fi
  out=$("$bin" entries "$act" --dir "$f" --kinds "$rel/reseed/kinds" 2>&1) || s=$?
  # the build's own lines (its rides, punts, stand points and header) are the world's start's to print, not this
  grep -E '^(entries|refused|worldd entries)' <<< "$out" || true
  [ "$s" = 0 ] || [ "$s" = 3 ] || echo "entries: $w: not upgraded: worldd entries $act exited $s"
  return "$s"
}

# entries plan|stage <sha> [<world>...]: entries_world for each world; a refused or failed world never stops the rest.
library() {
  local act=${1:-} sha=${2:-} rel w
  { [ "$act" = plan ] || [ "$act" = stage ]; } && [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "entries plan|stage <sha> [<world>...]"
  rel=$DATA/releases/$sha
  [ -f "$rel/manifest.json" ] || refuse "release.not-staged: $sha"
  shift 2
  # shellcheck disable=SC2046 # a world's name is one word
  if [ $# -eq 0 ]; then set -- $(worlds); fi
  for w in "$@"; do entries_world "$act" "$rel" "$w" || true; done
}

bodies_binding() {
  local file=${SOULS_CUTOVER_BINDING:-$ETC/cutover-binding.json} dir=$LIB/web/assets/bodies
  if [ ! -f "$file" ]; then
    echo "bodies: no cutover binding at $file"
  elif [ ! -f "$dir/bodies.json" ]; then
    echo "bodies: no catalogue at $dir; the binding is unchanged"
  else
    node -e "$BIND" "$file" "$dir" || echo "bodies: the binding at $file could not be read; it is unchanged"
  fi
}

# The owner's messages (R13): every world's gateway reads them from the directory with the install's mailbox key
# (gatewayd --mailbox <directory> --mailbox-key <key>; directoryd --mailbox-key <key>). Without them a message sent
# from a Soul's card is refused `no-mailbox`. MAILBOX_CFG <etc> plan|apply [<uid> <gid>]: the key made once (0600, the
# services' user), `--mailbox-key` added to directory.args and both flags to each gateway-<world>.env, when missing;
# a flag already there is left as it is. One line per change (`would …` in a plan), then `changed:` and what changed:
# `directory` and the worlds whose gateway file changed. Nothing when there is no directory.args (no directory here).
MAILBOX_CFG='const fs = require("fs"), crypto = require("crypto"), path = require("path");
const [etc, mode, uid, gid] = process.argv.slice(1), apply = mode === "apply", key = path.join(etc, "mailbox.key"), changed = [];
const say = (what) => console.log(`mailbox: ${apply ? "" : "would "}${what}`);
const args = path.join(etc, "directory.args");
if (!fs.existsSync(args)) { console.log(`mailbox: no directory here (${args}); nothing to set`); console.log("changed:"); process.exit(0); }
const words = (v) => v.replace(/^(["\x27])(.*)\1$/, "$2").split(/\s+/).filter(Boolean);
const flag = (v, f) => { const w = words(v), i = w.indexOf(f); return i < 0 ? null : (w[i + 1] ?? ""); };
const add = (v, more) => { const q = /^(["\x27]).*\1$/.test(v) ? v[0] : ""; const inner = q ? v.slice(1, -1) : v; return q + (inner.trimEnd() + " " + more).trim() + q; };
// edit <file> <NAME> <fn(value) -> new value | null>: the line NAME=…, rewritten in place (same mode and owner)
const edit = (file, name, fn) => {
  const text = fs.readFileSync(file, "utf8"), re = new RegExp(`^(\\s*(?:export\\s+)?${name}=)(.*)$`, "m"), m = text.match(re);
  if (!m) { console.log(`mailbox: ${file} has no ${name} line; left as it is`); return false; }
  const next = fn(m[2]);
  if (next === null) return false;
  if (apply) {
    const st = fs.statSync(file), tmp = `${file}.mailbox.new`;
    fs.writeFileSync(tmp, text.replace(re, (_, k) => k + next), { mode: st.mode & 0o777 });
    if (process.getuid() === 0) fs.chownSync(tmp, st.uid, st.gid);
    fs.renameSync(tmp, file);
  }
  return true;
};
if (!fs.existsSync(key)) {
  say(`make ${key} (a new key, 0600)`);
  if (apply) {
    fs.writeFileSync(key, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    if (process.getuid() === 0 && uid) fs.chownSync(key, Number(uid), Number(gid));
  }
  changed.push("key");
}
const listen = flag(fs.readFileSync(args, "utf8").match(/^\s*(?:export\s+)?DIRECTORYD_ARGS=(.*)$/m)?.[1] ?? "", "--listen") || "127.0.0.1:7310";
if (edit(args, "DIRECTORYD_ARGS", (v) => flag(v, "--mailbox-key") !== null ? null : add(v, `--mailbox-key ${key}`))) {
  say(`add --mailbox-key ${key} to ${args}`); changed.push("directory");
}
for (const f of fs.readdirSync(etc).filter((f) => /^gateway-.+\.env$/.test(f)).sort()) {
  const file = path.join(etc, f), world = f.slice(8, -4);
  let more = "";
  if (edit(file, "GATEWAYD_ARGS", (v) => {
    more = [flag(v, "--mailbox") === null ? `--mailbox ${listen}` : "", flag(v, "--mailbox-key") === null ? `--mailbox-key ${key}` : ""].filter(Boolean).join(" ");
    return more ? add(v, more) : null;
  })) { say(`add ${more} to ${file}`); changed.push(world); }
}
if (!changed.length) console.log("mailbox: the key, the directory and every gateway already have it");
console.log(`changed: ${changed.join(" ")}`);'
# MAILBOX_PROBE <etc>: through each world's gateway (its gateway-<world>.env: --listen, --view-key), as an owner's page
# sends: a view token for a grant no Soul holds (minted with the install's view key, two minutes), then `put` one
# message for it. `accepted` is the directory's id for it: the gateway has its mailbox and the directory took its key.
# Nothing reads the message (no client signs in for that grant, no page holds it) and it expires unread. Exits 1
# unless every gateway accepted.
MAILBOX_PROBE='const fs = require("fs"), crypto = require("crypto"), path = require("path");
const etc = process.argv[1], GRANT = `soul-${"f".repeat(32)}-0`;
const files = fs.readdirSync(etc).filter((f) => /^gateway-.+\.env$/.test(f)).sort();
const flag = (v, f) => { const w = v.replace(/^(["\x27])(.*)\1$/, "$2").split(/\s+/), i = w.indexOf(f); return i < 0 ? null : w[i + 1]; };
const cborText = (s) => { const b = Buffer.from(s); const h = b.length < 24 ? [0x60 + b.length] : b.length < 256 ? [0x78, b.length] : [0x79, b.length >> 8, b.length & 255]; return Buffer.concat([Buffer.from(h), b]); };
const probe = (world, listen, viewKey) => new Promise((done) => {
  const expires = Math.floor(Date.now() / 1000) + 120, body = `view.${expires}.${GRANT}`;
  const token = `${body}.${crypto.createHmac("sha256", Buffer.from(fs.readFileSync(viewKey, "utf8").trim(), "hex")).update(body).digest("hex")}`;
  const ws = new WebSocket(`ws://${listen}/v2/ws`); ws.binaryType = "arraybuffer";
  let step = 0;
  const end = (what) => { clearTimeout(t); try { ws.close(); } catch {} done(what); };
  const t = setTimeout(() => end("no-answer"), 10_000);
  ws.onopen = () => ws.send(Buffer.from([0xa2, 0x01, 0x02, 0x02, 0x40]));
  ws.onerror = () => end("not-reachable");
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      if (!ev.data.startsWith("{\"sent\"")) return;
      const s = JSON.parse(ev.data).sent ?? {};
      return end(s.id ? `accepted ${s.id}` : `refused ${s.refused}`);
    }
    const text = Buffer.from(ev.data).toString("latin1");
    if (step === 0) { step = 1; return ws.send(Buffer.concat([Buffer.from([0xa1, 0x01]), cborText(token)])); }
    if (step === 1 && text.includes("view.started")) { step = 2; return ws.send(`put ${GRANT}\nrelease check: a message for no Soul; it expires unread`); }
    if (step === 1 && text.includes("refused")) return end("refused view-token");
  };
});
(async () => {
  let bad = 0;
  if (!files.length) console.log("mailbox: no gateway here to check");
  for (const f of files) {
    const world = f.slice(8, -4), v = fs.readFileSync(path.join(etc, f), "utf8").match(/^\s*(?:export\s+)?GATEWAYD_ARGS=(.*)$/m)?.[1] ?? "";
    const listen = flag(v, "--listen"), viewKey = flag(v, "--view-key");
    const got = !listen ? "refused no-listen" : !viewKey ? "refused no-view-key" : await probe(world, listen, viewKey);
    if (!got.startsWith("accepted")) bad++;
    console.log(`mailbox: ${world}: an owner send ${got.startsWith("accepted") ? `is ${got}` : `was not accepted (${got})`}`);
  }
  process.exit(bad ? 1 : 0);
})();'

# mailbox plan|apply|check: MAILBOX_CFG's plan or change (apply prints `changed:` last), or MAILBOX_PROBE's check.
mailbox() {
  local u='' g=''
  case ${1:-} in
    plan) node -e "$MAILBOX_CFG" "$ETC" plan ;;
    apply)
      if id "${RELEASE_ACCOUNT:-souls}" > /dev/null 2>&1; then
        u=$(id -u "${RELEASE_ACCOUNT:-souls}") g=$(id -g "${RELEASE_ACCOUNT:-souls}")
      fi
      node -e "$MAILBOX_CFG" "$ETC" apply "$u" "$g"
      ;;
    check) node -e "$MAILBOX_PROBE" "$ETC" ;;
    *) die "mailbox plan|apply|check" ;;
  esac
}

bodies() {
  case ${1:-} in
    worlds) shift && [ $# -ge 1 ] || die "bodies worlds <page.tar> [<world>...]"; bodies_worlds "$@" ;;
    binding) bodies_binding ;;
    *) die "bodies worlds <page.tar> [<world>...] | bodies binding" ;;
  esac
}

move() {
  local sha=$1 canary=${2:-} rel=$DATA/releases/$1 worldd gw page client w order=() all
  [ -f "$rel/manifest.json" ] || refuse "release.not-staged: $sha"
  worldd=$(artifact "$rel/manifest.json" worldd) gw=$(artifact "$rel/manifest.json" gatewayd)
  page=$(artifact "$rel/manifest.json" page.tar) client=$(artifact "$rel/manifest.json" client.tar)
  all=$(worlds)
  [ -n "$all" ] || refuse "release.no-worlds: nothing under $WORLDS_ROOT/worlds"
  # @eden: Eden's world (the cut-over's, $ETC/cutover.env), the canary of a release that reseeded it (0.133 R13)
  if [ "$canary" = @eden ]; then
    canary=$(sed -n 's/^WORLD="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$ETC/cutover.env" 2> /dev/null)
    [ -n "$canary" ] || refuse "release.no-such-world: no Eden world in $ETC/cutover.env"
  fi
  canary=${canary:-$(head -1 <<< "$all")}
  grep -qxF -- "$canary" <<< "$all" || refuse "release.no-such-world: $canary"
  order=("$canary")
  while IFS= read -r w; do [ "$w" = "$canary" ] || order+=("$w"); done <<< "$all"
  directory_env
  echo "move: ${sha:0:12}: worldd ${worldd:0:16}…, canary $canary, then ${#order[@]} worlds in all"
  # each world's catalogue before its deploy, which restarts it: worldd reads bodies.json at start
  bodies_worlds "$WORLDS_ROOT/builds/$page/page.tar" "${order[@]}"
  for w in "${order[@]}"; do
    if [ -f "$rel/moved/$w" ]; then
      echo "move: $w already moved by this release"
      continue
    fi
    # its entries staged just before its deploy, which rehearses the new build on them and swaps them in at its
    # restart; a refused or failed stage stages none, and the world deploys on its own entries
    entries_world stage "$rel" "$w" || true
    echo "move: deploy $w$([ "$w" = "$canary" ] && echo ' (the canary)')"
    if "$rel/bin/deploy" "$w" "$worldd" --window-s "${RELEASE_WINDOW_S:-60}"; then
      touch "$rel/moved/$w"
    else
      # never left for a later deploy to take
      rm -rf "$WORLDS_ROOT/worlds/$w/entries.next"
      refuse "release.deploy-failed: $w (worlds after it keep their build; worlds before it keep this one)"
    fi
  done
  # The owner's messages (R13): the key and the flags, when missing, before the gateways and the directory restart on
  # the release below and read them. A rerun of a release whose gateways or directory had moved restarts what changed.
  local mb changed
  mb=$(mailbox apply) || refuse "release.mailbox-config: $(tail -1 <<< "$mb")"
  grep -v '^changed:' <<< "$mb" || true
  changed=$(sed -n 's/^changed: *//p' <<< "$mb")
  if [ -f "$rel/moved/gateway" ]; then
    echo "move: the gateway already moved by this release"
    for w in $changed; do
      case $w in key | directory) ;; *) echo "move: souls-gateway@$w restarts for its mailbox"; systemctl restart "souls-gateway@$w" || true ;; esac
    done
  else
    echo "move: gateway-upgrade to ${gw:0:16}…"
    install -m 755 "$rel/bin/assets-check" "$LIB/.assets-check.new" && mv "$LIB/.assets-check.new" "$LIB/assets-check"
    "$rel/bin/gateway-upgrade" "$WORLDS_ROOT/builds/$gw/gatewayd" "${order[@]}" --lib "$LIB" || refuse "release.gateway-failed"
    touch "$rel/moved/gateway"
  fi
  if [ -f "$rel/moved/page" ]; then
    echo "move: the page already moved by this release"
  else
    rm -rf "$LIB/.web.new" "$LIB/.web.old"
    mkdir -p "$LIB/.web.new"
    tar -xf "$WORLDS_ROOT/builds/$page/page.tar" -C "$LIB/.web.new"
    if [ -d "$LIB/web" ]; then mv "$LIB/web" "$LIB/.web.old"; fi
    mv "$LIB/.web.new" "$LIB/web"
    rm -rf "$LIB/.web.old"
    touch "$rel/moved/page"
    echo "move: the page is ${page:0:16}… ($LIB/web)"
  fi
  bodies_binding
  if [ -f "$rel/moved/client" ]; then
    echo "move: the served client already moved by this release"
  else
    rm -rf "$LIB/.client.new" "$LIB/.client.old"
    mkdir -p "$LIB/.client.new"
    tar -xf "$WORLDS_ROOT/builds/$client/client.tar" -C "$LIB/.client.new"
    if [ -d "$LIB/client" ]; then mv "$LIB/client" "$LIB/.client.old"; fi
    mv "$LIB/.client.new" "$LIB/client"
    rm -rf "$LIB/.client.old"
    touch "$rel/moved/client"
    echo "move: the served client is ${client:0:16}… ($LIB/client)"
  fi
  # Last, once the worlds and the gateway are on the release: the directory, then the viewers' origin. Each restart is
  # a blip of a second or two; the page tries again.
  local s
  if [ -f "$rel/moved/directory" ] && grep -qw directory <<< "$changed"; then
    echo "move: souls-directory.service restarts for its mailbox key"
    systemctl restart souls-directory.service || true
  fi
  for s in $SERVICES; do
    case $s in
      directory)
        service "$rel" directory souls-directory.service directoryd 401 -X POST "$(directory_url)/v1/account/session"
        ;;
      origin)
        service "$rel" origin souls-origin.service origin.tar 200 \
          "${RELEASE_ORIGIN_URL:-http://localhost:7320}$(stream_path "${order[@]}")"
        ;;
    esac
  done
  # After the restarts: an owner's send through each world's gateway must be accepted, not refused `no-mailbox`.
  if [ -f "$ETC/directory.args" ] && grep -qw directory <<< " $SERVICES "; then
    local seen
    seen=$(mailbox check) || { echo "$seen"; refuse "release.mailbox-unreachable: an owner's send was not accepted"; }
    echo "$seen"
  fi
  echo "moved: ${sha:0:12} is live on ${#order[@]} worlds, their gateways, the page, the served client$([ -z "$SERVICES" ] || echo ', the directory and the origin')"
}

# The directory's address, from directory.args' --listen. `|| true`: under pipefail a missing directory.args would end
# the caller here, silently (#4954).
directory_url() {
  local l
  l=$(sed -n 's/.*--listen[ =]\([^ "]*\).*/\1/p' "$ETC/directory.args" 2> /dev/null | head -1 || true)
  echo "${RELEASE_DIRECTORY_URL:-http://${l:-127.0.0.1:7310}}"
}

# The first of these worlds' streams the origin serves (place-world.sh links /w/<world>/views), as its pointer's path;
# with none, the origin's own feed.
stream_path() {
  local w s
  for w in "$@"; do
    s=$(sed -n 's/.*"stream": *"\([^"]*\)".*/\1/p' "$WORLDS_ROOT/worlds/$w/views/world.json" 2> /dev/null | head -1)
    if [ -n "$s" ]; then
      echo "/w/$w/${s%/}/pointer"
      return
    fi
  done
  echo /v1/feed
}

# The HTTP status a request gets (000 with no answer), asked every half second for RELEASE_HEALTH_S (30) seconds until
# it is <want>; prints the last one when it never was.
answers() {
  local want=$1 end=$((SECONDS + ${RELEASE_HEALTH_S:-30})) got
  shift
  while :; do
    got=$(curl -s -o /dev/null -m 2 -w '%{http_code}' "$@" 2> /dev/null || true)
    [ "$got" = "$want" ] && return 0
    if [ "$SECONDS" -ge "$end" ]; then
      echo "${got:-000}"
      return 1
    fi
    sleep 0.5
  done
}

# service <release> <name> <unit> <artifact> <want> <request...>: the release's program ($LIB/directoryd, or the folder
# $LIB/origin from origin.tar) and its unit file (from units.tar, then a daemon-reload) go in beside the old ones and
# are renamed over them, the unit is restarted once, and the request must get <want>. If it does not, the previous
# program and unit go back, the unit is restarted on them, and the release stops: `release.<name>-unhealthy`.
service() {
  local rel=$1 name=$2 unit=$3 a=$4 want=$5 h prog new prev changed=0 got again
  shift 5
  if [ -f "$rel/moved/$name" ]; then
    echo "move: $unit already moved by this release"
    return 0
  fi
  h=$(artifact "$rel/manifest.json" "$a")
  if [ -z "$h" ]; then
    echo "move: release ${rel##*/} carries no $a (staged by an older release.sh): $unit not moved"
    return 0
  fi
  prog=$LIB/${a%.tar} new=$LIB/.${a%.tar}.new prev=$LIB/.${a%.tar}.prev
  rm -rf "$new" "$prev" "$rel/units" "$rel/prev/$unit"
  if [ "$a" = "${a%.tar}" ]; then
    install -m 755 "$WORLDS_ROOT/builds/$h/$a" "$new"
  else
    mkdir -p "$new"
    tar --no-same-owner -xf "$WORLDS_ROOT/builds/$h/$a" -C "$new"
  fi
  mkdir -p "$rel/units" "$rel/prev"
  tar --no-same-owner -xf "$WORLDS_ROOT/builds/$(artifact "$rel/manifest.json" units.tar)/units.tar" -C "$rel/units"
  if ! cmp -s "$rel/units/$unit" "$UNITS/$unit"; then
    if [ -f "$UNITS/$unit" ]; then cp -p "$UNITS/$unit" "$rel/prev/$unit"; fi
    install -m 644 "$rel/units/$unit" "$UNITS/.$unit.new"
    mv "$UNITS/.$unit.new" "$UNITS/$unit"
    systemctl daemon-reload
    changed=1
  fi
  if [ -d "$new" ]; then
    if [ -e "$prog" ]; then mv "$prog" "$prev"; fi
  elif [ -e "$prog" ]; then
    cp -p "$prog" "$prev"
  fi
  mv "$new" "$prog"
  echo "move: $unit restarts on ${h:0:16}…$([ "$changed" = 0 ] || echo ' with its new unit file')"
  systemctl restart "$unit" || true
  if got=$(answers "$want" "$@"); then
    rm -rf "$prev"
    touch "$rel/moved/$name"
    echo "move: $unit answers $want on ${h:0:16}…"
    return 0
  fi
  echo "move: $unit answered $got, not $want: back to its previous program and unit"
  [ -e "$prev" ] || refuse "release.$name-unhealthy: $unit answered $got, not $want, and has no previous program to go back to"
  if [ -d "$prev" ]; then rm -rf "$prog"; fi
  mv "$prev" "$prog"
  if [ -f "$rel/prev/$unit" ]; then
    install -m 644 "$rel/prev/$unit" "$UNITS/.$unit.new"
    mv "$UNITS/.$unit.new" "$UNITS/$unit"
    systemctl daemon-reload
  fi
  systemctl restart "$unit" || true
  if again=$(answers "$want" "$@"); then
    refuse "release.$name-unhealthy: $unit answered $got, not $want, on ${h:0:16}…; back on its previous program it answers $want"
  fi
  refuse "release.$name-unhealthy: $unit answered $got, not $want, on ${h:0:16}…; back on its previous program it answers $again"
}

rollback() {
  local to=$1 from=$2 w rel status=0
  shift 2
  [ $# -gt 0 ] || die "rollback <to> <from> <world>..."
  [ "$to" != "$from" ] || refuse "rollback.same: to and from are one build"
  # The release that brought <from> carries the deploy tool that knows its schemas.
  rel=$(grep -l "\"name\":\"worldd\",\"hash\":\"$from\"" "$DATA"/releases/*/manifest.json 2> /dev/null | head -1 || true)
  [ -n "$rel" ] || refuse "rollback.from-unknown: no staged release has worldd $from"
  rel=$(dirname "$rel")
  [ -f "$WORLDS_ROOT/builds/$to/worldd" ] || refuse "rollback.to-missing: $to is not on this machine"
  directory_env
  for w in "$@"; do
    echo "rollback: $w to ${to:0:16}… from ${from:0:16}…"
    # A world on a store generation (a rebuild's, #4954) runs only a build that reads it: one from before would claim
    # the old world's record, take its shipping over and stop on a restart gap at every start.
    if [ -f "$WORLDS_ROOT/worlds/$w/generation" ] && ! grep -qa 'generation-bad: ' "$WORLDS_ROOT/builds/$to/worldd"; then
      echo "refused: rollback.generation: $w is on store generation g/$(tr -d '[:space:]' < "$WORLDS_ROOT/worlds/$w/generation")/, which ${to:0:16}… cannot read (a build from before #4954)"
      status=3
      continue
    fi
    if "$rel/bin/deploy" rollback "$w" "$to" --from "$from"; then
      rm -f "$rel/moved/$w"
    else
      status=3
    fi
  done
  return $status
}

# 0.133 R13: Eden's reseed as a release step, by the scripts, world-aside and kinds this release staged. The script
# finds this release's world-aside and kinds itself (reseed-eden.sh); `check` reads and prints, changing nothing.
reseed() {
  local sha=$1 act=${2:-} label=${3:-} rel=$DATA/releases/$1
  [[ $sha =~ ^[0-9a-f]{40}$ ]] && { [ "$act" = check ] || [ "$act" = run ]; } || die "reseed <sha> check|run [<label>]"
  [ -f "$rel/reseed/reseed-eden.sh" ] || refuse "release.no-reseed: release ${sha:0:12} carries no reseed (staged by an older release-v2)"
  if [ -n "$label" ]; then
    bash "$rel/reseed/reseed-eden.sh" "$sha" resume "$label" "$act"
  else
    bash "$rel/reseed/reseed-eden.sh" "$sha" "$act"
  fi
}

# Undoes the reseed <label>, with the undo of the release the reseed moved Eden to (its receipt's `new` build).
reseed_undo() {
  local label=$1 act=${2:-} receipt new rel
  [[ $label =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && { [ "$act" = check ] || [ "$act" = run ]; } || die "reseed-undo <label> check|run"
  # `|| true`: under pipefail a probe that finds nothing would end the script before its refusal says why (#4954).
  receipt=$(ls "$WORLDS_ROOT"/aside/*-"$label".reseed 2> /dev/null | head -1 || true)
  [ -f "$receipt" ] || refuse "release.no-reseed: no reseed receipt for $label"
  new=$(sed -n 's/^new=//p' "$receipt")
  rel=$(grep -l "\"name\":\"worldd\",\"hash\":\"$new\"" "$DATA"/releases/*/manifest.json 2> /dev/null | head -1 || true)
  [ -n "$rel" ] && [ -f "$(dirname "$rel")/reseed/reseed-eden-undo.sh" ] || refuse "release.no-reseed: no staged release carries the undo for $label"
  RESEED_TOOL=${RESEED_TOOL:-$(dirname "$rel")/bin/world-aside} bash "$(dirname "$rel")/reseed/reseed-eden-undo.sh" "$label" "$act"
}

# New world (#5047, #5051). The placement initializer (souls-place.service) forks a template of the catalogue with the
# library's worldd, which must hash to placement.json's `build`, and worldd forks only a template published on its own
# build. So after each release's move: every template republished on its build and dry-run forked (check stops there),
# then the library's worldd and ops/, the pin and the templates renamed into place, and the directory, which reads the
# catalogue (each template's name, lineage and zone) only at its start, restarted when that changed.
DRY_RUN_THROUGH=dddddddddddddddddddddddddddddddd:1
SWAPPED=()
conf() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? ""))' "$1" "$2"; }
# PIN <placement.json> <build> <out>: the file with `build` set, written to <out> with the file's mode and owner.
PIN='const fs = require("fs"), [file, build, out] = process.argv.slice(1), c = JSON.parse(fs.readFileSync(file, "utf8"));
const st = fs.statSync(file); c.build = build; fs.writeFileSync(out, JSON.stringify(c) + "\n"); fs.chmodSync(out, st.mode & 0o777);
if (process.getuid() === 0) fs.chownSync(out, st.uid, st.gid);'
# The catalogue as the directory reads it at its start: each folder with a `template` file, by name and that file's hash.
catalogue() {
  local t
  for t in "$1"/*/; do
    if [ -f "$t/template" ]; then echo "$(basename "$t") $(hash "$t/template")"; fi
  done
}
# swap <new> <live> <prev>: <new> renamed to <live>, the previous <live> kept as <prev> (replacing an older one).
swap() {
  rm -rf "$3"
  if [ -e "$2" ]; then mv "$2" "$3"; fi
  mv "$1" "$2"
  SWAPPED+=("$2" "$3")
}
# Every swap undone, last first: each <prev> back as its <live>.
unswap() {
  local i
  for ((i = ${#SWAPPED[@]} - 2; i >= 0; i -= 2)); do
    if [ -e "${SWAPPED[i + 1]}" ]; then
      rm -rf "${SWAPPED[i]}"
      mv "${SWAPPED[i + 1]}" "${SWAPPED[i]}"
    fi
  done
}

# republish <name> <template> <work> <worldd> <publish-template>: the template seeded again from what it carries (its
# facts, entries, moves, entry point and body catalogue), published as <work>/out/<name> and dry-run forked, all by
# this release's programs.
republish() {
  local name=$1 src=$2 work=$3 w=$4 pub=$5 at=0,0 out opt=()
  [ -f "$src/facts.json" ] || refuse "release.template-unreadable: $name has no facts.json"
  [ ! -d "$src/hatches" ] || refuse "release.template-hatches: $name carries code hatches, which publish-template does not carry"
  mkdir -p "$work/support"
  if [ -f "$src/moves.json" ]; then cp "$src/moves.json" "$work/support/"; fi
  if [ -d "$src/entries" ]; then opt+=(--entries "$src/entries"); fi
  if [ -f "$src/bodies.json" ]; then opt+=(--bodies "$src/bodies.json"); fi
  # entry.json is [x, z] in mm; seed takes metres and truncates, so half a millimetre outward keeps each exact
  if [ -f "$src/entry.json" ]; then
    at=$(node -e 'const [x, z] = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), m = (v) => (v + Math.sign(v) / 2) / 1000; process.stdout.write(`${m(x)},${m(z)}`)' "$src/entry.json") ||
      refuse "release.template-unreadable: $name's entry.json"
  fi
  out=$("$w" seed --facts "$src/facts.json" --souls 0 --at "$at" --dir "$work/support" ${opt[@]+"${opt[@]}"} 2>&1) ||
    refuse "release.template-seed: $name: $(tail -1 <<< "$out")"
  if [ -f "$src/entry.json" ] && [ "$(tr -d ' \n' < "$src/entry.json")" != "$(tr -d ' \n' < "$work/support/entry.json")" ]; then
    refuse "release.template-entry: $name's entry point would change"
  fi
  out=$("$pub" "$src/facts.json" "$work/out" --name "$name" --support "$work/support" 2>&1) ||
    refuse "release.template-publish: $name: $(tail -1 <<< "$out")"
  [ -f "$work/out/$name/template" ] || refuse "release.template-publish: $name: publish-template made no $name (one from before #5047 takes no --name)"
  out=$("$w" fork --from "$work/out/$name/ckpt" --template "$work/out/$name" --to "$work/fork" --through "$DRY_RUN_THROUGH" 2>&1) ||
    refuse "release.template-fork: $name: $(tail -1 <<< "$out")"
  echo "placement: $name republished and dry-run forked: $(grep -m1 '^fork:' <<< "$out" || tail -1 <<< "$out")"
}

placement() {
  local sha=${1:-} act=${2:-} cfg=$ETC/placement.json rel lib tpl pin h w next was now names t s plan=()
  [[ $sha =~ ^[0-9a-f]{40}$ ]] && { [ "$act" = check ] || [ "$act" = run ]; } || die "placement <sha> check|run"
  rel=$DATA/releases/$sha
  [ -f "$rel/manifest.json" ] || refuse "release.not-staged: $sha"
  if [ ! -f "$cfg" ]; then
    echo "placement: no $cfg: this machine makes no new worlds"
    return 0
  fi
  if [ "$act" = run ] && [ -f "$rel/moved/placement" ]; then
    echo "placement: already done by this release"
    return 0
  fi
  [ -x "$rel/bin/templates" ] && [ -d "$rel/ops" ] || refuse "release.no-placement: release ${sha:0:12} carries no publish-template or ops/ (staged by an older release-v2)"
  lib=$(conf "$cfg" library) tpl=$(conf "$cfg" templates) pin=$(conf "$cfg" build)
  [ -n "$lib" ] && [ -n "$tpl" ] || refuse "release.placement-config: $cfg names no library or templates"
  h=$(artifact "$rel/manifest.json" worldd) w=$WORLDS_ROOT/builds/$h/worldd
  # Made beside the catalogue, never in it (the directory would list a stray folder there), on its disk: each swap
  # below is a rename. Whatever is left of it, or of a new file not renamed into place, goes when this ends.
  next=$(dirname "$tpl")/.templates.next
  # shellcheck disable=SC2064 # these paths, now
  trap "rm -rf '$next' '$lib/.worldd.new' '$lib/.ops.new' '$ETC/.placement.json.new'" EXIT
  rm -rf "$next"
  mkdir -p "$next"
  was=$(catalogue "$tpl")
  names=$(awk '{print $1}' <<< "$was" | tr '\n' ' ')
  echo "placement: ${sha:0:12}: worldd ${h:0:16}…, templates: ${names:-none}"
  for t in $names; do republish "$t" "$tpl/$t" "$next/$t" "$w" "$rel/bin/templates"; done
  cmp -s "$w" "$lib/worldd" || plan+=("the library's worldd")
  diff -rq "$rel/ops" "$lib/ops" > /dev/null 2>&1 || plan+=("its ops/")
  [ "$pin" = "$h" ] || plan+=("the pin (was ${pin:0:16}…)")
  for t in $names; do plan+=("$t"); done
  if [ "$act" = check ]; then
    echo "placement: run would rename into place: ${plan[*]:-nothing}; check only, nothing changed"
    return 0
  fi
  # Everything made and checked first; then the renames, back to back.
  if ! cmp -s "$w" "$lib/worldd"; then install -m 755 "$w" "$lib/.worldd.new"; fi
  if ! diff -rq "$rel/ops" "$lib/ops" > /dev/null 2>&1; then
    rm -rf "$lib/.ops.new"
    cp -R "$rel/ops" "$lib/.ops.new"
    chmod -R u=rwX,go=rX "$lib/.ops.new"
  fi
  if [ "$pin" != "$h" ]; then node -e "$PIN" "$cfg" "$h" "$ETC/.placement.json.new"; fi
  for t in $names; do chmod -R u=rwX,go=rX "$next/$t/out/$t"; done
  mkdir -p "$tpl/.aside"
  if [ -f "$lib/.worldd.new" ]; then swap "$lib/.worldd.new" "$lib/worldd" "$lib/.worldd.prev"; fi
  if [ -d "$lib/.ops.new" ]; then swap "$lib/.ops.new" "$lib/ops" "$lib/.ops.prev"; fi
  if [ -f "$ETC/.placement.json.new" ]; then swap "$ETC/.placement.json.new" "$cfg" "$ETC/.placement.json.prev"; fi
  for t in $names; do swap "$next/$t/out/$t" "$tpl/$t" "$tpl/.aside/$t"; done
  echo "placement: renamed into place: ${plan[*]:-nothing}"
  now=$(catalogue "$tpl")
  if [ "$now" = "$was" ]; then
    echo "placement: the catalogue the directory reads is unchanged: not restarted"
  elif ! grep -qw directory <<< " $SERVICES "; then
    echo "placement: no directory runs here (RELEASE_SERVICES): not restarted"
  else
    echo "placement: souls-directory.service restarts to read the catalogue"
    systemctl restart souls-directory.service || true
    if ! s=$(answers 401 -X POST "$(directory_url)/v1/account/session"); then
      echo "placement: souls-directory.service answered $s, not 401: the previous worldd, ops/, pin and templates go back"
      unswap
      systemctl restart souls-directory.service || true
      refuse "release.placement-directory-unhealthy: souls-directory.service answered $s, not 401, on the republished catalogue; the previous one is back"
    fi
    echo "placement: souls-directory.service answers 401"
  fi
  touch "$rel/moved/placement"
  echo "placement: new worlds are made on ${h:0:16}…"
}

news() {
  local sha=$1 version=$2 link=$3 date=$4 rel=$DATA/releases/$1 w f=$DATA/news.jsonl
  [ -f "$rel/manifest.json" ] || refuse "release.not-staged: $sha"
  # Only what is live is announced: every world this release moved and none rolled back.
  for w in $(worlds); do [ -f "$rel/moved/$w" ] || refuse "release.not-live: $w is not on ${sha:0:12}"; done
  if [ -f "$f" ] && grep -qF "\"link\":\"$link\"" "$f"; then
    echo "news: already has $link"
    return 0
  fi
  { [ ! -f "$f" ] || cat "$f"; printf '{"kind":"release","version":"%s","commit":"%s","date":"%s","link":"%s"}\n' "$version" "$sha" "$date" "$link"; } > "$f.new"
  mv "$f.new" "$f"
  echo "news: one entry, $link"
}

# In a checkout of main whose origin is the repository: each of the three only when it is not there yet.
publish() {
  local version=$1 sha=$2 date=$3 tag=v$1 at shipped f tmp branch compile
  compile=${RELEASE_COMPILE:-$(dirname "$0")/../../../../tools/changelog/compile.mjs}
  git fetch -q origin main "+refs/tags/$tag:refs/tags/$tag" 2> /dev/null || git fetch -q origin main
  at=$(git rev-parse -q --verify "refs/tags/$tag^{commit}" || true)
  if [ -n "$at" ] && [ "$at" != "$sha" ]; then refuse "release.tag-elsewhere: $tag is at ${at:0:12}, not ${sha:0:12}"; fi
  if [ -n "$at" ]; then
    echo "publish: tag $tag already at ${sha:0:12}"
  else
    git tag -a "$tag" "$sha" -m "Souls $version"
    git push -q origin "$tag"
    echo "publish: tagged $tag at ${sha:0:12}"
  fi
  branch=release/changelog-$version
  # Read whole, not piped into grep -q: under pipefail git show, cut off when grep stops at the first match, would fail
  # the test and the changelog would be opened again (#4954).
  if grep -q "^## $version " <<< "$(git show origin/main:CHANGELOG.md 2> /dev/null || true)"; then
    echo "publish: CHANGELOG.md on main already has $version"
  elif [ -n "$(git ls-remote --heads origin "$branch")" ]; then
    echo "publish: the changelog's branch $branch is already there"
  else
    shipped=$(git ls-tree --name-only "$sha" changes/ | grep -vE '^changes/(README|_template)\.md$' | grep -E '\.md$' || true)
    tmp=$(mktemp -d)
    mkdir -p "$tmp/changes"
    for f in $shipped; do git show "$sha:$f" > "$tmp/$f"; done
    git show origin/main:CHANGELOG.md > "$tmp/CHANGELOG.md" 2> /dev/null || true
    node "$compile" --root "$tmp" --version "$version" --date "$date" --notes "$tmp/notes.md" > /dev/null
    git checkout -q -B "$branch" origin/main
    cp "$tmp/CHANGELOG.md" CHANGELOG.md
    for f in $shipped; do git rm -q --ignore-unmatch "$f"; done
    git add CHANGELOG.md
    git commit -q -m "release: changelog for $version" -m "Folds the shipped changes/ fragments into CHANGELOG.md ($tag at ${sha:0:12})."
    git push -q -u origin "$branch"
    echo "publish: the changelog's section for $version on $branch"
    if [ "${RELEASE_GH:-1}" = 1 ]; then
      gh release view "$tag" > /dev/null 2>&1 || gh release create "$tag" --verify-tag --title "Souls $version" --notes-file "$tmp/notes.md"
      GH_TOKEN=${PR_TOKEN:-${GH_TOKEN:-}} gh pr create --base main --head "$branch" --label no-changelog \
        --title "release: changelog for $version" --body "Folds the fragments shipped in $tag (${sha:0:12}) into CHANGELOG.md. Created by release-v2.yml."
    fi
    rm -rf "$tmp"
  fi
}

remote() {
  local target=${RELEASE_TARGET:?set RELEASE_TARGET to the machine} cmd
  local ssh=${RELEASE_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=20}
  if [ "$1" = stage ]; then
    [ -f "$2/manifest.json" ] || die "remote stage <bundle>"
    cmd="set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; tar -xzf - -C \"\$d\"; bash \"\$d/release.sh\" stage \"\$d\""
    # shellcheck disable=SC2086 # RELEASE_SSH is a command with its options
    COPYFILE_DISABLE=1 tar -C "$2" -czf - . | $ssh "$target" "$cmd"
  else
    # this file, fed to bash on the machine
    # shellcheck disable=SC2086
    $ssh "$target" "bash -s -- $(printf '%q ' "$@")" < "$0"
  fi
}

main() {
  local cmd=${1:-}
  shift || true
  case $cmd in
    checks | bundle | stage | verify | move | bodies | mailbox | rollback | reseed | placement | news | publish | remote) "$cmd" "$@" ;;
    reseed-undo) reseed_undo "$@" ;;
    entries) library "$@" ;;
    *) die "checks|bundle|publish|remote|stage|verify|move|bodies|mailbox|entries|rollback|reseed|reseed-undo|placement|news (see the top of this file)" ;;
  esac
}

main "$@"
