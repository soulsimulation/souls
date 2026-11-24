#!/usr/bin/env bash
# One release of Engine v2 is one commit (Engine v2 O18, #2811): built once, staged by hash, moved by canary, rolled
# back by a workflow. `.github/workflows/release-v2.yml` and `rollback-v2.yml` run it; docs: v2/docs/release.md.
#
# On the runner:
#   bash release.sh checks <sha>                       refuses `release.missing-check: <name>` for each check of
#                                                      v2/docs/release.md's list the head has not passed (gh api); the
#                                                      merge queue's green `ci` run at <sha> counts for its CI checks
#   bash release.sh bundle <out> <sha> <version> <cargo release dir> <page dist dir> <client dir> [<wasm pkg dir>]
#                                                      the four artifacts, the tools and manifest.json (name, hash);
#                                                      client.tar is the served client (v2/client/served/build.mjs,
#                                                      R17 #2818), each served file a `served` line of the manifest;
#                                                      reseed/ holds Eden's reseed, its undo and content/kinds
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
#                                  ($LIB/client, which a world's address serves); each step done once per release
#   rollback <to> <from> <world>...   `deploy rollback`: refuses unless each world is pinned to <from>
#   reseed <sha> check|run [<label>]   Eden fresh on this release's build (reseed/reseed-eden.sh with this release's
#                                  world-aside and kinds); with <label>, resumes that reseed. check changes nothing
#   reseed-undo <label> check|run  undoes that reseed, with the undo the release it moved to carried
#   news <sha> <version> <link> <date>   one release entry in $DATA/news.jsonl, keyed by its link; refuses
#                                  `release.not-live` unless this release moved every world
# A refusal prints `refused: <name>: <why>` and exits 3; it changes nothing it has not already done.
set -euo pipefail

DATA=${RELEASE_DATA:-/var/lib/souls}
WORLDS_ROOT=${WORLDS_ROOT:-$DATA/worlds}
LIB=${RELEASE_LIB:-/usr/local/lib/souls}
ETC=${RELEASE_ETC:-/etc/souls}
export WORLDS_ROOT
# The four artifacts of a release, by their names under builds/<hash>/; worldd's hash is its build (O1, O7).
ARTIFACTS=(worldd gatewayd page.tar client.tar)
# What moves them, carried with the release; world-aside sets a world's store objects aside for a reseed (0.133 R13);
# assets-check, the gateway's uploads checker (#1960), goes in beside the gateway when the gateway moves.
TOOLS=(deploy gateway-upgrade world-aside assets-check)
# A reseed of Eden, carried under reseed/ with the kinds it seeds from (content/kinds at the release's commit).
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
  COPYFILE_DISABLE=1 tar -C "$page" -cf "$out/artifacts/page.tar" .
  # The served client (R17): its files by name, version, length and hash, as soul-client.json gives them. Its version
  # is x.y.z (build.mjs), so a minor release's (0.132) is stamped 0.132.0; a patch's (0.131.1) is its own.
  local stamp=$version
  if [[ $version =~ ^[0-9]+\.[0-9]+$ ]]; then stamp=$version.0; fi
  node "$client/served/build.mjs" --out "$out/served" --version "$stamp" --pkg "$pkg" > /dev/null
  COPYFILE_DISABLE=1 tar -C "$out/served" -cf "$out/artifacts/client.tar" .
  for t in "$out"/served/*; do
    [ "${t##*/}" = soul-client.json ] && continue
    served+=("$(printf '{"served":"%s","version":"%s","hash":"%s","bytes":%s}' "${t##*/}" "$stamp" "$(hash "$t")" "$(wc -c < "$t" | tr -d ' ')")")
  done
  rm -rf "$out/served"
  for t in "${TOOLS[@]}"; do install -m 755 "$bins/$t" "$out/bin/$t"; done
  install -m 755 "$0" "$out/release.sh"
  mkdir -p "$out/reseed"
  for t in "${RESEED[@]}"; do install -m 755 "$(dirname "$0")/../cutover/$t" "$out/reseed/$t"; done
  cp -R "$(dirname "$0")/../../../../content/kinds" "$out/reseed/kinds"
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
  rm -rf "$rel/reseed"
  cp -R "$from/reseed" "$rel/reseed"
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
  for w in "${order[@]}"; do
    if [ -f "$rel/moved/$w" ]; then
      echo "move: $w already moved by this release"
      continue
    fi
    echo "move: deploy $w$([ "$w" = "$canary" ] && echo ' (the canary)')"
    if "$rel/bin/deploy" "$w" "$worldd" --window-s "${RELEASE_WINDOW_S:-60}"; then
      touch "$rel/moved/$w"
    else
      refuse "release.deploy-failed: $w (worlds after it keep their build; worlds before it keep this one)"
    fi
  done
  if [ -f "$rel/moved/gateway" ]; then
    echo "move: the gateway already moved by this release"
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
  echo "moved: ${sha:0:12} is live on ${#order[@]} worlds, their gateways, the page and the served client"
}

rollback() {
  local to=$1 from=$2 w rel status=0
  shift 2
  [ $# -gt 0 ] || die "rollback <to> <from> <world>..."
  [ "$to" != "$from" ] || refuse "rollback.same: to and from are one build"
  # The release that brought <from> carries the deploy tool that knows its schemas.
  rel=$(grep -l "\"name\":\"worldd\",\"hash\":\"$from\"" "$DATA"/releases/*/manifest.json 2> /dev/null | head -1)
  [ -n "$rel" ] || refuse "rollback.from-unknown: no staged release has worldd $from"
  rel=$(dirname "$rel")
  [ -f "$WORLDS_ROOT/builds/$to/worldd" ] || refuse "rollback.to-missing: $to is not on this machine"
  directory_env
  for w in "$@"; do
    echo "rollback: $w to ${to:0:16}… from ${from:0:16}…"
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
  receipt=$(ls "$WORLDS_ROOT"/aside/*-"$label".reseed 2> /dev/null | head -1)
  [ -f "$receipt" ] || refuse "release.no-reseed: no reseed receipt for $label"
  new=$(sed -n 's/^new=//p' "$receipt")
  rel=$(grep -l "\"name\":\"worldd\",\"hash\":\"$new\"" "$DATA"/releases/*/manifest.json 2> /dev/null | head -1)
  [ -n "$rel" ] && [ -f "$(dirname "$rel")/reseed/reseed-eden-undo.sh" ] || refuse "release.no-reseed: no staged release carries the undo for $label"
  RESEED_TOOL=${RESEED_TOOL:-$(dirname "$rel")/bin/world-aside} bash "$(dirname "$rel")/reseed/reseed-eden-undo.sh" "$label" "$act"
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
  if git show origin/main:CHANGELOG.md 2> /dev/null | grep -q "^## $version "; then
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
    checks | bundle | stage | verify | move | rollback | reseed | news | publish | remote) "$cmd" "$@" ;;
    reseed-undo) reseed_undo "$@" ;;
    *) die "checks|bundle|publish|remote|stage|verify|move|rollback|reseed|reseed-undo|news (see the top of this file)" ;;
  esac
}

main "$@"
