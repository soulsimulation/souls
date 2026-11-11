#!/usr/bin/env node
// Two ordinary release steps (#1969), run by release.yml from a checkout of the release head:
//
//   node release-client.mjs stamp --version <release> [--client <client version>]
//     Before the gate. When eden.mjs or skill.md changed since the last release (the newest v* tag reachable from HEAD) and
//     the client still carries that release's version or no longer matches its stamp, stamps it (stamp.mjs <client>;
//     default: the next patch) and commits the stamp. Then stamp.mjs --check; exit 1 on any disagreement. Prints
//     `client=<version> stamped=<0|1>` as its last line.
//   node release-client.mjs feed --version <release> --origin <https origin> (--port <launcher port> [--base /] | --ssh <target>)
//     After the health checks. Posts one `release` item through the operator route (/__sim/op/feed-post, as op.mjs
//     feed-post): the client version, the changelog link (<origin>/changelog#v<release>, the release's id in the feed) and
//     minClient when SOUL_CLIENT_MIN was raised since the last release. Idempotent: when the feed already holds a release
//     item with that link, it posts nothing. --port talks to a launcher on this machine; --ssh runs the same program on
//     the production host against its live launcher (the route is loopback only).
import { execFileSync } from 'node:child_process';
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
if (!['stamp', 'feed'].includes(cmd) || !/^[0-9]+(\.[0-9]+){1,2}$/.test(version ?? '')) {
  console.error('usage: release-client.mjs stamp --version <release> [--client <v>]\n'
    + '       release-client.mjs feed --version <release> --origin <https origin> (--port <p> [--base /] | --ssh <target>)');
  process.exit(2);
}
let last; try { last = git('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'); } catch { fail('no v* tag reachable from HEAD: no last release to compare with'); }

if (cmd === 'stamp') {
  const lastClient = CLI_LINE.exec(at(last, `${SOUL}eden.mjs`) ?? '')?.[1], nowClient = CLI_LINE.exec(head(`${SOUL}eden.mjs`))?.[1];
  const changed = ['eden.mjs', 'skill.md'].some((f) => at(last, SOUL + f) !== head(SOUL + f));
  const off = problems((p) => { try { return readFileSync(ROOT + SOUL + p); } catch { return null; } });
  let stamped = 0, client = nowClient;
  if (changed && lastClient && nowClient && (nowClient === lastClient || off.length)) {
    client = flag('client') ?? nowClient.replace(/\d+$/, (n) => String(Number(n) + 1));
    try { execFileSync(process.execPath, [`${ROOT}${SOUL}stamp.mjs`, client], { stdio: 'inherit' }); } catch { fail(`stamp.mjs ${client} failed`); }
    git('add', '--', `${SOUL}eden.mjs`, `${SOUL}skill.md`, `${SOUL}SOURCES.json`);
    git('commit', '-q', '-m', `release: stamp the Soul client ${client} for ${version}`, '-m', `The client changed since ${last} (client ${lastClient}); stamp.mjs ${client}.`);
    stamped = 1;
    console.log(`stamp commit ${git('rev-parse', 'HEAD')}: client ${lastClient} (${last}) -> ${client}`);
  } else console.log(changed ? `client ${nowClient} already stamped since ${last} (client ${lastClient})` : `client unchanged since ${last}`);
  try { execFileSync(process.execPath, [`${ROOT}${SOUL}stamp.mjs`, '--check'], { stdio: 'inherit' }); } catch { fail('stamp.mjs --check failed: the release stops'); }
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
