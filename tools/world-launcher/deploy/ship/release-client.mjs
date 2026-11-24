#!/usr/bin/env node
// The Soul client's stamp and the release's feed item (#1969):
//
//   node release-client.mjs stamp [--client <client version>]
//     On main, by eden-sync.yml after each push that touches the client, so main's client is stamped before any release
//     head is picked (0.133 R13: a stamp made by the release itself was a new head that needed CI again). First
//     rebuilds a stale eden.mjs from its modules (inline.mjs), which then counts as changed. When eden.mjs or skill.md
//     changed since the last release (the newest v* tag reachable from HEAD) and the client still carries that
//     release's version or no longer matches its stamp, stamps it in the tree (stamp.mjs <client>; default: the next
//     patch); eden-sync.yml commits it. Then stamp.mjs --check; exit 1 on any disagreement. Prints
//     `client=<version> stamped=<0|1>` as its last line.
//   node release-client.mjs check --version <release>
//     release.yml's preflight, from a checkout of the release head; changes nothing. Exit 1 when the head's client is
//     not stamped (eden.mjs stale, or changed since the last release without a stamp): the release head is then one
//     from before eden-sync's pull request merged. Prints `client=<version> stamped=0` as its last line.
//   node release-client.mjs feed --version <release> --origin <https origin> (--port <launcher port> [--base /] | --ssh <target>)
//     After the health checks. Posts one `release` item through the operator route (/__sim/op/feed-post, as op.mjs
//     feed-post): the client version, the changelog link (<origin>/changelog#v<release>, the release's id in the feed) and
//     minClient when SOUL_CLIENT_MIN was raised since the last release. Idempotent: when the feed already holds a release
//     item with that link, it posts nothing. --port talks to a launcher on this machine; --ssh runs the same program on
//     the production host against its live launcher (the route is loopback only). For a release already tagged, run it
//     from a checkout of v<release> (release.yml feed_only=true).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { problems } from '../../soul/stamp.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOUL = 'tools/world-launcher/soul/', MIN_FILE = 'apps/server/src/soul-client-manifest.ts';
const CLI_LINE = /^const VERSION = "([0-9.]+)";$/m, MIN_LINE = /^export const SOUL_CLIENT_MIN = '([0-9.]+)';$/m;
const argv = process.argv.slice(2), cmd = argv[0];
const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const at = (ref, path) => { try { return execFileSync('git', ['-C', ROOT, 'show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }); } catch { return null; } };
const head = (path) => readFileSync(ROOT + path, 'utf8');
const fail = (m) => { console.error(m); process.exit(1); };

const version = flag('version');
if (!['stamp', 'check', 'feed'].includes(cmd) || (cmd !== 'stamp' && !/^[0-9]+(\.[0-9]+){1,2}$/.test(version ?? ''))) {
  console.error('usage: release-client.mjs stamp [--client <v>]\n'
    + '       release-client.mjs check --version <release>\n'
    + '       release-client.mjs feed --version <release> --origin <https origin> (--port <p> [--base /] | --ssh <target>)');
  process.exit(2);
}
// the last release before this one: v<release> itself is skipped, so a feed post for an already-tagged release (release.yml
// feed_only, from a checkout of its tag) compares with the release before it, as the ship's own post did
let last; try { last = git('describe', '--tags', '--abbrev=0', '--match', 'v*', ...(version ? ['--exclude', `v${version}`] : []), 'HEAD'); } catch { fail('no v* tag reachable from HEAD: no last release to compare with'); }

if (cmd === 'stamp' || cmd === 'check') {
  // PRs do not carry a rebuilt eden.mjs (docs/testing.md#the-soul-client-file): when this head's copy is not what
  // inline.mjs builds from its modules, eden-sync rebuilds it here into its pull request, so a release never serves a
  // stale client
  const inline = `${ROOT}${SOUL}inline.mjs`;
  const rebuilt = spawnSync(process.execPath, [inline, '--check'], { stdio: 'ignore' }).status !== 0;
  const notYet = (why) => fail(`${why}: this head is from before eden-sync.yml's pull request (bot/eden-sync-*) merged. Release that merge or a later commit; to open the pull request now: gh workflow run eden-sync.yml --ref main`);
  if (rebuilt && cmd === 'check') notYet('eden.mjs is not what its modules build');
  if (rebuilt) {
    try { execFileSync(process.execPath, [inline], { stdio: 'inherit' }); } catch { fail('inline.mjs could not build eden.mjs: the release stops'); }
    console.log('eden.mjs was stale: rebuilt from its modules (inline.mjs)');
  }
  const lastClient = CLI_LINE.exec(at(last, `${SOUL}eden.mjs`) ?? '')?.[1], nowClient = CLI_LINE.exec(head(`${SOUL}eden.mjs`))?.[1];
  const changed = ['eden.mjs', 'skill.md'].some((f) => at(last, SOUL + f) !== head(SOUL + f));
  const off = problems((p) => { try { return readFileSync(ROOT + SOUL + p); } catch { return null; } });
  let stamped = 0, client = nowClient;
  if (changed && lastClient && nowClient && (nowClient === lastClient || off.length)) {
    if (cmd === 'check') notYet(`the Soul client changed since ${last} (client ${lastClient}) and is not stamped`);
    client = flag('client') ?? nowClient.replace(/\d+$/, (n) => String(Number(n) + 1));
    try { execFileSync(process.execPath, [`${ROOT}${SOUL}stamp.mjs`, client], { stdio: 'inherit' }); } catch { fail(`stamp.mjs ${client} failed`); }
    stamped = 1;
    console.log(`stamped in the tree: client ${lastClient} (${last}) -> ${client}`);
  } else console.log(changed ? `client ${nowClient} already stamped since ${last} (client ${lastClient})` : `client unchanged since ${last}`);
  try { execFileSync(process.execPath, [`${ROOT}${SOUL}stamp.mjs`, '--check'], { stdio: 'inherit' }); } catch { fail('stamp.mjs --check failed'); }
  console.log(`client=${client} stamped=${stamped}`);
} else {
  const origin = flag('origin');
  if (!/^https:\/\/[^/\s]+$/.test(origin ?? '') || !(flag('port') || flag('ssh'))) fail('feed: --origin https://<host> and --port or --ssh');
  const client = CLI_LINE.exec(head(`${SOUL}eden.mjs`))?.[1], minNow = MIN_LINE.exec(head(MIN_FILE))?.[1], minLast = MIN_LINE.exec(at(last, MIN_FILE) ?? '')?.[1];
  if (!client || !minNow) fail(`feed: no client version in ${SOUL}eden.mjs or SOUL_CLIENT_MIN in ${MIN_FILE}`);
  const raised = minLast !== minNow;
  const item = { kind: 'release', title: `Soul ${version}`, url: `${origin}/changelog#v${version}`,
    body: `Release ${version} is live. Soul client ${client}.${raised ? ` Clients older than ${minNow} must upgrade: eden upgrade.` : ''}`, ...(raised ? { minClient: minNow } : {}) };
  // One program, run by node from stdin here (--port) or on the host (--ssh): read the whole feed on loopback; post only
  // when no release item carries this link. argv: <port> <base>.
  const program = `const [port, base] = process.argv.slice(2), root = 'http://127.0.0.1:' + port + base.replace(/\\/$/, ''), item = ${JSON.stringify(item)};
const say = (d) => console.log(JSON.stringify(d, null, 2));
for (let after = '';;) {
  const r = await fetch(root + '/v1/feed?limit=100' + (after ? '&after=' + after : '')); if (!r.ok) { say({ status: r.status, read: 'feed' }); process.exit(1); }
  const d = await r.json(), hit = d.items.find((i) => i.kind === 'release' && i.url === item.url);
  if (hit) { say({ status: 200, alreadyPosted: true, item: hit }); process.exit(0); }
  if (!d.items.length || d.next === after) break; after = d.next;
}
const r = await fetch(root + '/__sim/op/feed-post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item) });
say({ status: r.status, ...(await r.json().catch(() => ({}))) }); process.exit(r.ok ? 0 : 1);`;
  // On the host: the live launcher's port, as the runbook reads it; base /.
  const [bin, args] = flag('port') ? [process.execPath, ['--input-type=module', '-', flag('port'), flag('base') ?? '']]
    : ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', flag('ssh'), `P=$(sed -n 's/.*--port \\([0-9]*\\).*/\\1/p' /etc/sim-worlds/production.conf) && node --input-type=module - "$P" /`]];
  try { process.stdout.write(execFileSync(bin, args, { encoding: 'utf8', input: program })); } catch (e) { process.stdout.write(e.stdout ?? ''); fail('feed: the release item was not posted'); }
}
