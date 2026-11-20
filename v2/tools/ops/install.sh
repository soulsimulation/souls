#!/usr/bin/env bash
# Installs Engine v2's programs beside today's system on one Linux machine (Engine v2 O17, #2810). Runbook:
# v2/docs/runbook/install.md.
#
#   bash install.sh plan --from <bundle>        prints what apply would change, and changes nothing (the default)
#   bash install.sh apply --from <bundle>       as root: makes it so; a second run changes nothing
#   bash install.sh uninstall                   as root: removes what apply made, and only that
#   bash install.sh check                       the test: nothing it writes is today's system's (a repo checkout)
#   bash install.sh bundle <out> <cargo release dir> <page dist dir>   puts a bundle together (the workflow)
#   INSTALL_TARGET=<ssh target> bash install.sh remote <plan|apply|uninstall> <bundle>
#                                               runs it on another machine through `$INSTALL_SSH <target> <command>`
#
# What it makes: the unprivileged user souls; the programs in /usr/local/lib/souls (supervisor, worldd, gatewayd,
# directoryd, deploy, gateway-upgrade, import-accounts, import-world, the origin and the page's files); data in
# /var/lib/souls; settings in /etc/souls, the secrets file root-owned; the units souls.slice, worldd@ (with its drop-in), souls-gateway@,
# souls-directory and souls-origin.
# Carried over from today's installer: idempotent, and it starts, enables and restarts nothing. It never reads or
# writes today's units, users, data, proxy, DNS or firewall: it refuses, changing nothing, when anything it would
# make is already there and not its own (install.state records what it made).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

R=${INSTALL_ROOT:-} # plan only: a folder standing in for / (the check plans into an empty one)
ACCOUNT=souls
LIB=/usr/local/lib/souls
DATA=/var/lib/souls
ETC=/etc/souls
UNITS=/etc/systemd/system
STATE=$ETC/install.state
PROGRAMS=(supervisor worldd gatewayd directoryd deploy gateway-upgrade import-accounts import-world)
UNIT_FILES=(souls.slice worldd@.service souls-gateway@.service souls-directory.service souls-origin.service)
DROPIN=$UNITS/worldd@.service.d
# Everything it may make, and so everything it may remove: the user, three folders it owns whole, its units.
OWNED=("user $ACCOUNT" "tree $LIB" "tree $DATA" "tree $ETC" "tree $DROPIN")
for u in "${UNIT_FILES[@]}"; do OWNED+=("file $UNITS/$u"); done

die() {
  echo "install: $*" >&2
  exit 2
}

MODE=plan
CHANGES=0
UNITS_CHANGED=0
# One change: printed as `would <what>` in a plan, `did <what>` when applied.
act() {
  local what=$1
  shift
  CHANGES=$((CHANGES + 1))
  if [ "$MODE" = plan ]; then
    echo "would $what"
  else
    "$@"
    echo "did $what"
  fi
}

has_user() { [ -z "$R" ] && id -u "$ACCOUNT" > /dev/null 2>&1; }
owned_exists() {
  case $1 in
    user\ *) has_user ;;
    *) [ -e "$R${1#* }" ] ;;
  esac
}
recorded() { [ -f "$R$STATE" ] && grep -qxF "$1" "$R$STATE"; }
record() { [ "$MODE" = plan ] || recorded "$1" || echo "$1" >> "$STATE"; }

# Refuses, changing nothing, when something it would make is already there and not recorded as its own.
preflight() {
  local item foreign=()
  for item in "${OWNED[@]}"; do
    if owned_exists "$item" && ! recorded "$item"; then foreign+=("$item"); fi
  done
  if [ ${#foreign[@]} -gt 0 ]; then
    printf 'install: already there and not made by this install: %s\n' "${foreign[@]}" >&2
    echo "install: refusing; nothing changed" >&2
    exit 3
  fi
}

perms() { stat -c '%a %U %G' "$1"; }

ensure_user() {
  has_user && return 0
  act "user $ACCOUNT" useradd --system --user-group --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
}

# ensure_dir <path> <mode> <owner> <group> [owned item to record]
ensure_dir() {
  local p=$1 m=$2 o=$3 g=$4
  if [ ! -d "$R$p" ]; then
    act "dir $p $m $o:$g" install -d -m "$m" -o "$o" -g "$g" "$p"
  elif [ "$(perms "$R$p")" != "$m $o $g" ]; then
    act "perms $p $m $o:$g" bash -c 'chown "$1" "$2" && chmod "$3" "$2"' _ "$o:$g" "$p" "$m"
  fi
  if [ $# -gt 4 ]; then record "$5"; fi
}

# ensure_file <source> <path> <mode> <owner> <group>: the source's bytes, mode and owner, written only when they differ.
ensure_file() {
  local s=$1 p=$2 m=$3 o=$4 g=$5
  [ -f "$s" ] || die "the bundle has no $s"
  if [ -f "$R$p" ] && cmp -s "$s" "$R$p" && [ "$(perms "$R$p")" = "$m $o $g" ]; then return 0; fi
  act "file $p $m $o:$g" install -m "$m" -o "$o" -g "$g" "$s" "$p"
  case $p in "$UNITS"/*) UNITS_CHANGED=1 ;; esac
}

# ensure_once <path> <mode> <owner> <group> <text>: written when absent, never overwritten (the owner edits it).
ensure_once() {
  local p=$1 m=$2 o=$3 g=$4 text=$5
  [ -e "$R$p" ] && return 0
  act "file $p $m $o:$g (once)" bash -c 'umask 077; printf "%s\n" "$1" > "$2" && chown "$3" "$2" && chmod "$4" "$2"' _ "$text" "$p" "$o:$g" "$m"
}

# ensure_tree <source dir> <path>: every file of the source, root-owned and world-readable; files the source lacks go.
ensure_tree() {
  local src=$1 dst=$2 f rel
  [ -d "$src" ] || die "the bundle has no $src"
  ensure_dir "$dst" 755 root root
  while IFS= read -r rel; do
    ensure_dir "$dst/$rel" 755 root root
  done < <(cd "$src" && find . -mindepth 1 -type d | sed 's|^\./||' | sort)
  while IFS= read -r rel; do
    ensure_file "$src/$rel" "$dst/$rel" 644 root root
  done < <(cd "$src" && find . -type f | sed 's|^\./||' | sort)
  [ -d "$R$dst" ] || return 0
  while IFS= read -r rel; do
    [ -e "$src/$rel" ] || act "remove $dst/$rel" rm -rf "$dst/$rel"
  done < <(cd "$R$dst" && find . -mindepth 1 | sed 's|^\./||' | sort -r)
}

DIRECTORY_PORT=7310 # on loopback; the origin's, 7320, is in souls-origin.service
# The directory's arguments, written once. It listens on this machine's IPv4 loopback address, as localhost resolves
# (directoryd takes an address, not a name).
directory_args() {
  local lo
  lo=$(getent ahostsv4 localhost 2> /dev/null | awk 'NR == 1 {print $1}') || true
  if [ -z "$lo" ]; then
    [ "$MODE" = plan ] || die "localhost has no IPv4 address"
    lo='<loopback>'
  fi
  cat << EOF
# Arguments for souls-directory.service (directoryd; v2/crates/directoryd/src/accounts/start.rs). Written once by
# the install, never overwritten. Add the sign-in provider (--issuer <https origin> --parties <origin,...>) before
# starting it; only the configured origin mounts sign-in (docs/operations/auth.md).
DIRECTORYD_ARGS=--listen $lo:$DIRECTORY_PORT --public-url https://soul.game --store $DATA/directory
EOF
}
SECRETS="# Secrets for Engine v2's programs, KEY=value lines (root only; systemd reads it before a unit drops to souls)."

install_all() {
  local from=$1 p u args
  [ -d "$from" ] || die "--from <bundle> is a folder (bash install.sh bundle makes one)"
  args=$(directory_args)
  from=$(cd "$from" && pwd)
  # The record's folder first, then the user recorded before it is made, so a run that stops anywhere leaves nothing
  # unrecorded. The folder's group is the user's, so it is root's until the user exists.
  local group=root
  if has_user; then group=$ACCOUNT; fi
  ensure_dir "$ETC" 750 root "$group" "tree $ETC"
  record "user $ACCOUNT"
  ensure_user
  if [ "$MODE" = apply ] || [ -d "$R$ETC" ]; then
    ensure_dir "$ETC" 750 root "$ACCOUNT"
  else
    act "perms $ETC 750 root:$ACCOUNT" true
  fi
  ensure_dir "$LIB" 755 root root "tree $LIB"
  for p in "${PROGRAMS[@]}"; do ensure_file "$from/bin/$p" "$LIB/$p" 755 root root; done
  ensure_tree "$from/origin" "$LIB/origin"
  ensure_tree "$from/web" "$LIB/web"
  ensure_dir "$DATA" 750 "$ACCOUNT" "$ACCOUNT" "tree $DATA"
  for p in worlds directory views; do ensure_dir "$DATA/$p" 750 "$ACCOUNT" "$ACCOUNT"; done
  ensure_once "$ETC/directory.args" 640 root "$ACCOUNT" "$args"
  ensure_once "$ETC/origin.env" 640 root "$ACCOUNT" "# Browser provider: AUTH_PROVIDER=clerk, CLERK_PUBLISHABLE_KEY, CLERK_ISSUER_URL.
# Optional CLERK_SATELLITE_DOMAIN and CLERK_SIGN_IN_URL. Never put secrets or tokens here.
# Private ops settings: SIM_SITE_OWNERS, SOULS_OPS_PUBLIC_ORIGIN, CLERK_AUTHORIZED_PARTIES.
# Match the provider and application origin configured for souls-directory.
SOULS_OPS_DIRECTORY=http://127.0.0.1:$DIRECTORY_PORT"
  ensure_once "$ETC/secrets.env" 600 root root "$SECRETS"
  for u in "${UNIT_FILES[@]}"; do
    record "file $UNITS/$u"
    ensure_file "$from/units/$u" "$UNITS/$u" 644 root root
  done
  ensure_dir "$DROPIN" 755 root root "tree $DROPIN"
  ensure_file "$from/units/worldd-install.conf" "$DROPIN/10-install.conf" 644 root root
  if [ "$UNITS_CHANGED" = 1 ]; then act "systemctl daemon-reload" systemctl daemon-reload; fi
}

# The machine: Linux with systemd 254 or later (worldd@ uses RestartSteps) and cgroup v2; node for the origin.
machine() {
  local v
  [ "$(uname -s)" = Linux ] || die "needs Linux"
  v=$(systemctl --version 2> /dev/null | awk 'NR == 1 {print $2}')
  [ "${v:-0}" -ge 254 ] 2> /dev/null || die "needs systemd 254 or later, found ${v:-none}"
  [ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || die "needs cgroup v2"
  command -v node > /dev/null || echo "install: warning: no node on PATH; souls-origin needs it" >&2
}

# Refuses unless every unit of the install is inactive or failed (not running, starting, stopping or reloading) and
# none is enabled, its instances included.
units_quiet() {
  local busy enabled
  # (souls.slice is left out here: a slice stays active after its last unit stops, and runs nothing itself)
  busy=$(systemctl list-units --all --no-legend --plain 'worldd@*' 'souls-*' 2> /dev/null |
    awk '$3 != "inactive" && $3 != "failed" {print $1 " (" $3 ")"}')
  enabled=$({
    systemctl list-unit-files --no-legend --plain 'worldd@*' 'souls-*' 'souls.slice' 2> /dev/null |
      awk '$2 ~ /^(enabled|linked|alias)/ {print $1}'
    find /etc/systemd/system /run/systemd/system -path '*.wants/*' \( -name 'worldd@*' -o -name 'souls-*' \) 2> /dev/null |
      sed 's|.*/||'
  } | sort -u)
  [ -z "$busy" ] || die "not stopped, stop them first; nothing changed: $(echo "$busy" | tr '\n' ' ')"
  [ -z "$enabled" ] || die "enabled, disable them first; nothing changed: $(echo "$enabled" | tr '\n' ' ')"
}

# Removes what the record lists. A data folder that holds files is kept, and with it what it needs to be used again:
# the user and group that own it, /etc/souls (the record, secrets.env, directory.args, gateway-*.env), so a later
# apply takes them back as its own. Removing the data is a production delete, the owner's to do by hand.
uninstall() {
  local item keep=0
  units_quiet
  [ -f "$STATE" ] || {
    echo "nothing installed (no $STATE)"
    exit 0
  }
  if recorded "tree $DATA" && [ -n "$(find "$DATA" -type f -print -quit 2> /dev/null)" ]; then keep=1; fi
  for item in "${OWNED[@]}"; do
    recorded "$item" || continue
    case $item in
      tree\ "$DATA" | tree\ "$ETC" | user\ *) if [ "$keep" = 1 ]; then continue; fi ;;
    esac
    case $item in
      file\ *) act "remove ${item#file }" rm -f "${item#file }" ;;
      tree\ "$ETC") ;; # last: it holds the record
      tree\ *) act "remove ${item#tree }" rm -rf "${item#tree }" ;;
      user\ *) if has_user; then act "user $ACCOUNT removed" userdel "$ACCOUNT"; fi ;;
    esac
    if [ "$keep" = 1 ]; then
      act "unrecord $item" bash -c 'grep -vxF "$1" "$2" > "$2.new"; mv "$2.new" "$2"' _ "$item" "$STATE"
    fi
  done
  if [ "$keep" = 1 ]; then
    echo "kept $DATA: it holds data; kept the user $ACCOUNT and $ETC with it (apply takes them back)"
  else
    if recorded "user $ACCOUNT" && getent group "$ACCOUNT" > /dev/null; then act "group $ACCOUNT removed" groupdel "$ACCOUNT"; fi
    act "remove $ETC" rm -rf "$ETC"
  fi
  act "systemctl daemon-reload" systemctl daemon-reload
}

# A2: plans into an empty folder and checks that nothing it would make, and no unit, user or port it names, is one
# today's installer or units name (read from tools/world-launcher/deploy, so this file names none of them).
check() {
  local today=$HERE/../../../tools/world-launcher/deploy ours theirs bad=0 o t
  [ -f "$today/install.sh" ] || die "check runs in a repo checkout (no $today/install.sh)"
  tmp=$(mktemp -d) # global: the EXIT trap reads it
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/root" "$tmp/bins" "$tmp/page"
  for p in "${PROGRAMS[@]}"; do printf '%s\n' "$p" > "$tmp/bins/$p"; done
  echo '<!doctype html>' > "$tmp/page/index.html"
  bundle "$tmp/b" "$tmp/bins" "$tmp/page" > "$tmp/bundle"
  INSTALL_ROOT=$tmp/root bash "$0" plan --from "$tmp/b" > "$tmp/plan"
  for p in import-accounts import-world; do
    cmp -s "$tmp/bins/$p" "$tmp/b/bin/$p" || die "check: $p missing or changed in bundle"
    [ -n "$(find "$tmp/b/bin/$p" -prune -perm 755)" ] || die "check: $p bundle mode is not 755"
    grep -qxF "would file $LIB/$p 755 root:root" "$tmp/plan" || die "check: $p missing from plan"
  done
  (
    # Exercise the same file comparison as apply, entirely under the fixture root. Root ownership is simulated;
    # bytes and modes are real. Plan mode ensures even a regression cannot write to the machine installation.
    R=$tmp/root
    mkdir -p "$R$LIB" "$R$ETC"
    printf '%s\n' "${OWNED[@]}" > "$R$STATE"
    recorded "tree $LIB" || die "check: programs are not owned by the installation record"
    preflight
    perms() {
      if [ -n "$(find "$1" -prune -perm 755)" ]; then echo '755 root root'; else echo '644 root root'; fi
    }
    for p in import-accounts import-world; do
      CHANGES=0
      ensure_file "$tmp/b/bin/$p" "$LIB/$p" 755 root root > "$tmp/missing"
      [ "$CHANGES" = 1 ] || die "check: missing $p was not planned"
      install -m 755 "$tmp/b/bin/$p" "$R$LIB/$p"
      CHANGES=0
      ensure_file "$tmp/b/bin/$p" "$LIB/$p" 755 root root
      [ "$CHANGES" = 0 ] || die "check: identical $p is not inert"
      printf 'changed\n' >> "$R$LIB/$p"
      ensure_file "$tmp/b/bin/$p" "$LIB/$p" 755 root root > "$tmp/changed"
      [ "$CHANGES" = 1 ] || die "check: changed $p was not planned"
      install -m 644 "$tmp/b/bin/$p" "$R$LIB/$p"
      CHANGES=0
      ensure_file "$tmp/b/bin/$p" "$LIB/$p" 755 root root > "$tmp/mode"
      [ "$CHANGES" = 1 ] || die "check: $p mode was not repaired"
    done
  )
  echo 'check: both importers bundled at 755, recorded, planned, inert for identical bytes and repaired for changed bytes or mode'
  ours=$tmp/ours theirs=$tmp/theirs
  {
    awk '$1 == "would" && $2 ~ /^(dir|file)$/ {print "path " $3} $1 == "would" && $2 == "user" {print "user " $3}' "$tmp/plan"
    for u in "${UNIT_FILES[@]}"; do echo "unit ${u%%.*}"; done
    echo "unit ${DROPIN##*/}" | sed 's/\.service\.d$//'
    echo "port $DIRECTORY_PORT"
    cat "$HERE"/units/* | grep -oE '[0-9]{4,5} localhost' | grep -oE '[0-9]{4,5}' | sed 's/^/port /'
  } | sort -u > "$ours"
  local files=("$today"/*.sh "$today"/*.service "$today"/*.timer "$today"/*.socket "$today"/caddy/*)
  {
    cat "${files[@]}" 2> /dev/null | grep -oE '/(srv|opt|etc|var|home|usr|run)/[A-Za-z0-9@._/-]*[A-Za-z0-9]' | sed 's/^/path /'
    cat "${files[@]}" 2> /dev/null | grep -oE 'useradd [^;&|]*' | awk '{print "user " $NF}'
    cat "${files[@]}" 2> /dev/null | grep -oE '(User|Group)=[a-z][a-z0-9_-]*' | cut -d= -f2 | sed 's/^/user /'
    cat "${files[@]}" 2> /dev/null | grep -oE -- '-o [a-z][a-z0-9_-]* -g' | awk '{print "user " $2}'
    for f in "$today"/*.service "$today"/*.timer "$today"/*.socket; do t=${f##*/}; echo "unit ${t%%.*}"; done
    cat "${files[@]}" 2> /dev/null | grep -oE '[a-z][a-z0-9-]*@?\.(service|timer|socket|slice)' | sed 's/\..*//; s/^/unit /'
    cat "${files[@]}" 2> /dev/null | grep -oE -- '--port [0-9]+|:[0-9]{4,5}([^0-9]|$)' | grep -oE '[0-9]{4,5}' | sed 's/^/port /'
    cat "${files[@]}" 2> /dev/null | grep -oE -- '--range [0-9]+-[0-9]+' | while read -r _ r; do seq "${r%-*}" "${r#*-}"; done | sed 's/^/port /'
  } | sort -u > "$theirs"
  # The folders both systems share and neither owns; anything else of theirs is owned whole by them.
  local shared=' / /etc /etc/systemd /etc/systemd/system /usr /usr/local /usr/local/lib /var /var/lib /var/tmp /run /tmp /home /srv /opt '
  while read -r kind o; do
    while read -r tkind t; do
      [ "$kind" = "$tkind" ] || continue
      if [ "$o" = "$t" ]; then bad=1; echo "check: shared $kind: $o" >&2; fi
      if [ "$kind" = path ] && [[ $shared != *" $t "* ]] && [[ $o == "$t"/* ]]; then bad=1; echo "check: $o is inside $t" >&2; fi
    done < "$theirs"
  done < "$ours"
  [ "$(grep -c '' "$ours")" -gt 10 ] && [ "$(grep -c '' "$theirs")" -gt 10 ] || die "check found too little to compare"
  echo "check: $(grep -c '' "$ours") paths, users, units and ports of this install against $(grep -c '' "$theirs") of today's system: $([ $bad = 0 ] && echo none shared || echo SHARED)"
  return $bad
}

bundle() {
  local out=$1 bins=$2 page=$3 p
  [ -d "$page" ] || die "no page build at $page"
  mkdir -p "$out/bin" "$out/units"
  for p in "${PROGRAMS[@]}"; do install -m 755 "$bins/$p" "$out/bin/$p"; done
  rm -rf "$out/origin" "$out/web"
  mkdir -p "$out/origin"
  cp "$HERE/../origin/origin.mjs" "$HERE/../origin/cache.mjs" "$HERE/../origin/site.mjs" "$HERE/../origin/ops.mjs" "$HERE/../origin/owner-auth.mjs" "$HERE/../origin/world-routes.mjs" "$HERE/../../client/served/serve.mjs" "$out/origin/"
  cp "$HERE/../../../tools/world-launcher/owner-overview-data.mjs" "$out/origin/"
  cp -R "$page" "$out/web"
  cp "$HERE"/units/* "$out/units/"
  install -m 755 "$0" "$out/install.sh"
  echo "bundle: $(cd "$out" && find . -type f | wc -l | tr -d ' ') files in $out"
}

remote() {
  local action=$1 from=$2 target=${INSTALL_TARGET:?set INSTALL_TARGET to the machine to install on} cmd
  case $action in plan | apply | uninstall) ;; *) die "remote plan|apply|uninstall <bundle>" ;; esac
  [ -f "$from/install.sh" ] || die "$from is not a bundle"
  cmd="set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; tar -xzf - -C \"\$d\"; bash \"\$d/install.sh\" $action --from \"\$d\""
  [ "$action" != uninstall ] || cmd="set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT; tar -xzf - -C \"\$d\"; bash \"\$d/install.sh\" uninstall"
  # shellcheck disable=SC2086 # INSTALL_SSH is a command with its options
  COPYFILE_DISABLE=1 tar -C "$from" -czf - . | ${INSTALL_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=20} "$target" "$cmd"
}

main() {
  local cmd=${1:-plan} from=""
  shift || true
  while [ $# -gt 0 ]; do
    case $1 in
      --from)
        from=${2:-}
        shift
        ;;
      *) break ;;
    esac
    shift
  done
  case $cmd in
    plan)
      MODE=plan
      [ -n "$R" ] || machine
      preflight
      install_all "${from:?plan --from <bundle>}"
      [ "$CHANGES" -gt 0 ] && echo "plan: $CHANGES changes; nothing changed" || echo "plan: nothing to change"
      ;;
    apply)
      [ -z "$R" ] || die "INSTALL_ROOT is for plans only"
      [ "$(id -u)" = 0 ] || die "apply runs as root"
      MODE=apply
      machine
      preflight
      install_all "${from:?apply --from <bundle>}"
      echo "applied: $CHANGES changes (nothing started)"
      ;;
    uninstall)
      [ -z "$R" ] || die "INSTALL_ROOT is for plans only"
      [ "$(id -u)" = 0 ] || die "uninstall runs as root"
      MODE=apply
      uninstall
      echo "uninstalled: $CHANGES changes"
      ;;
    check) check ;;
    bundle) bundle "$@" ;;
    remote) remote "$@" ;;
    *) die "plan|apply|uninstall|check|bundle|remote (see the top of $0)" ;;
  esac
}

main "$@"
