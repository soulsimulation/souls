#!/usr/bin/env bash
# give-world.mjs end to end with the real directoryd and gatewayd, as the Eden fix's test was run on 27 Nov: an
# account signs in (the test sign-in) and gets a principal of its own; a world whose creator no account holds has a
# gateway with no creator flags, so its creator's page gets no creator token. give-world then gives the world to the
# account; the account's sign-in gets the token and anyone else's is refused. systemctl is a stand-in that starts and
# stops these two programs. Nothing leaves its scratch folder (removed after a pass).
#
#   bash v2/tools/ops/tests/give-world-e2e.sh <folder with directoryd and gatewayd>   (cargo build -p directoryd -p gatewayd)
set -euo pipefail
B=$(cd "${1:?a folder with directoryd and gatewayd}" && pwd)
HERE=$(cd "$(dirname "$0")/.." && pwd)
# Short folders: the gateway's control socket sits beside the world's tokens file, and a socket's path has at most 107
# bytes, so the map's worldsRoot here is /w (production's /var/lib/souls/worlds leaves no room for a prefix).
R=$(mktemp -d /tmp/gwXXXXXX); R=$(cd "$R" && pwd)
free() { node -e 's=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
DP=$(free) GP=$(free)
X=$(printf '9%.0s' {1..32}) I=$(printf 'a%.0s' {1..32})-$(printf 'a%.0s' {1..32})-0
ETC=$R/etc/souls W=$R/w/worlds/$I STORE=/var/lib/souls/directory/accounts.sqlite
mkdir -p "$ETC/placement-data" "$W" "$R/var/lib/souls/directory" "$R/pids"
od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$ETC/view.key"
echo "DIRECTORYD_ARGS=--listen 127.0.0.1:$DP --public-url http://127.0.0.1:$DP --store $STORE --test-sign-in --view-key /etc/souls/view.key" > "$ETC/directory.args"
echo "{\"format\":\"souls/world-authority/1\",\"aliases\":{},\"worldsRoot\":\"/w\",\"worlds\":{\"eden\":{\"creator\":\"$X:0\",\"instance\":\"$I\"}}}" > "$ETC/placement-data/authority.json"
echo "{\"format\":\"souls/world/1\",\"name\":\"$I\",\"creator\":\"$X-0\"}" > "$W/world.json"
printf '# World-bound pairing authority\n# souls-creator/1 0 %s:0\n' "$X" > "$W/tokens"
echo "GATEWAYD_ARGS=--listen 127.0.0.1:$GP --world $R/none.sock --tokens $W/tokens --build 1220$(printf 'ab%.0s' {1..32})" > "$ETC/gateway-$I.env"

# systemctl, for these two units: the paths the installed files name, under $R.
cat > "$R/systemctl" <<S
#!/usr/bin/env bash
up() { [ -f "$R/pids/\$1" ] && kill -0 "\$(cat "$R/pids/\$1")" 2>/dev/null; }
down() { if up \$1; then kill "\$(cat "$R/pids/\$1")"; while up \$1; do sleep 0.1; done; fi; rm -f "$R/pids/\$1"; }
start() {
  case \$1 in
    souls-directory.service) a=\$(sed -n 's/^DIRECTORYD_ARGS=//p' "$ETC/directory.args" | sed "s| /| $R/|g"); "$B/directoryd" \$a >> "$R/directory.log" 2>&1 & ;;
    souls-gateway@*) a=\$(sed -n 's/^GATEWAYD_ARGS=//p' "$ETC/gateway-$I.env"); "$B/gatewayd" \$a >> "$R/gateway.log" 2>&1 & ;;
  esac
  echo \$! > "$R/pids/\$1"; sleep 1.5
}
echo "\$*" >> "$R/systemctl.log"
case \$1 in
  stop) down \$2 ;; start) start \$2 ;; restart) down \$2; start \$2 ;; is-active) up \$3 ;;
esac
S
chmod +x "$R/systemctl"
export GIVE_ROOT=$R GIVE_SYSTEMCTL=$R/systemctl
fail=0
ok() { echo "ok   $*"; }
no() { echo "FAIL $*"; fail=1; }
token() { curl -s -o /dev/null -w '%{http_code}' -XPOST -H "authorization: Bearer test:$1" "http://127.0.0.1:$GP/v2/creator-token"; }
finish() { "$R/systemctl" stop souls-gateway@$I.service; "$R/systemctl" stop souls-directory.service; [ $fail = 0 ] && rm -rf "$R" || echo "kept $R"; }
trap finish EXIT

"$R/systemctl" start souls-directory.service
curl -s -XPOST -H 'content-type: application/json' -d '{"name":"gene"}' "http://127.0.0.1:$DP/v1/account/test-sign-in" > /dev/null
"$R/systemctl" start souls-gateway@$I.service
ACCOUNT=$(node --no-warnings -e '
  const fs=require("fs"),os=require("os"),p=require("path"),{DatabaseSync}=require("node:sqlite"),d=fs.mkdtempSync(p.join(os.tmpdir(),"e2e-"));
  for (const s of ["","-wal","-shm"]) if (fs.existsSync(process.argv[1]+s)) fs.copyFileSync(process.argv[1]+s,p.join(d,"db"+s));
  console.log(new DatabaseSync(p.join(d,"db")).prepare("SELECT account_id a FROM provider_accounts_v1").get().a)' "$R$STORE" 2>/dev/null)
[[ "$ACCOUNT" =~ ^acct_ ]] && ok "the test sign-in made an account with a principal of its own" || no "no account ($ACCOUNT)"
[ "$(token gene)" = 404 ] && ok "before: the gateway has no creator flags, so the account gets no creator token (404)" || no "before: $(token gene)"

node --no-warnings "$HERE/give-world.mjs" eden "$ACCOUNT" check > "$R/check.out"
[ ! -s "$R/systemctl.log.after-check" ] && grep -q 'check only' "$R/check.out" && ok "check: $(grep -c give-world "$R/check.out") lines, nothing changed" || no "check"
node --no-warnings "$HERE/give-world.mjs" eden "$ACCOUNT" run > "$R/run.out" 2>&1 && ok "run: $(tail -1 "$R/run.out")" || { cat "$R/run.out"; no "run failed"; }
[ "$(token gene)" = 200 ] && ok "after: the account's sign-in gets the world's creator token (200)" || no "after: $(token gene)"
[ "$(token someone)" = 403 ] && ok "after: another account's sign-in is refused not-the-creator (403)" || no "another: $(token someone)"
ls "$R/var/lib/souls/directory/" | grep -q 'before-give-eden' && ls "$ETC" | grep -q "gateway-$I.env.before-creator" && ok "the store and the gateway file were backed up" || no "backups"
node --no-warnings "$HERE/give-world.mjs" eden "$ACCOUNT" run > "$R/again.out" 2>&1 && [ "$(grep -c 'no change' "$R/again.out")" = 2 ] && ok "a second run changes nothing" || no "second run"
exit $fail
