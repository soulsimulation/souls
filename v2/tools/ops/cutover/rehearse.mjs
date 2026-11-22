#!/usr/bin/env node
// The cut-over rehearsed on a scratch host (Engine v2 X7, #2836): the switch and the switch back, twice, each by
// cutover.sh as the release owner runs it on production, timed. Never touches a production machine.
//
// The scratch host is one folder under .local/: O18's scratch machine (release/scratch.sh: Eden worlds seeded from N1's
// facts and served by `worldd serve` under the supervisor, their gateways, history shipped to a folder store standing
// in for the bucket) and O19's front door as its stand-in runs it (proxy/standin.mjs: Caddy in today's layout on
// loopback, the live release's proxy folder, a `systemctl` that reloads the scratch Caddy and runs a unit's ExecStart),
// in front of a stand-in for today's launcher and a directory answering W3's list with `eden`. Production's names,
// paths and ports are swapped for the scratch host's; cutover.sh runs as written otherwise.
//
// It records: which system serves Eden's page every 100 ms throughout (the front door's history); both systems running
// at every moment; Eden's claims in the store before and after (one writer: no new claim, the world never restarted);
// the files each command changed (none of them a name's address: no DNS change); each command's time; and what a
// rollback counts as made since the switch (an account and a Soul made while switched).
//
//   node v2/tools/ops/cutover/rehearse.mjs --bundle <install bundle> --facts <eden facts.json> --entries <content/kinds> [--keep]
// The bundle is `install.sh bundle` (v2/docs/release.md). Exit 0 when every step comes out as it should.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { testPort } from '../../../../apps/server/test/test-port.ts';
import { frontCheck } from '../front-check.mjs';

const here = dirname(fileURLToPath(import.meta.url)), repo = resolve(here, '../../../..'), ops = resolve(here, '..');
const today = join(repo, 'tools/world-launcher/deploy/caddy');
const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const [bundle, facts, entries] = ['--bundle', '--facts', '--entries'].map((k) => opt(k) && resolve(opt(k)));
if (!bundle || !facts || !entries) { console.error('usage: rehearse.mjs --bundle <install bundle> --facts <facts.json> --entries <content/kinds> [--keep]'); process.exit(2); }
mkdirSync(join(repo, '.local'), { recursive: true });
const dir = mkdtempSync(join(repo, '.local', 'cutover-'));
const R = join(dir, 'host'), machine = join(dir, 'machine'), store = join(dir, 'store');
const P0 = await testPort(6);
const port = { today: P0, directory: P0 + 1, origin: P0 + 2, admin: P0 + 3, public: P0 + 4, primary: P0 + 5 };
const at = (p) => `http://127.0.0.1:${p}`;
const t0 = Date.now(), clock = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (s) => console.log(`${clock()} ${s}`);
const stops = [];
const sh = (cmd, args, env = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

// The new system: O18's scratch machine, its worlds' history shipped to a folder store (each start is a claim there).
const up = sh('bash', [join(ops, 'release/scratch.sh'), 'up', machine, bundle, facts, entries], { WORLDD_STORE: `folder:${store}` });
if (up.status !== 0) throw Error(`scratch.sh up: ${up.stderr}`);
stops.push(() => sh('bash', [join(ops, 'release/scratch.sh'), 'down', machine]));
const world = /Eden world ([0-9a-f]{32}-[0-9a-f]{32}-\d+) seeded/.exec(up.stdout)[1];
const [lineage, zone] = [world.slice(0, 32), world.slice(0, 32) + world.slice(65)];
log(`scratch machine: ${up.stdout.trim().split('\n').length} Eden worlds served; Eden is ${world.slice(0, 12)}…`);
const starts = () => { try { return (readFileSync(join(machine, 'units', `worldd@${world}.out`), 'utf8').match(/^worldd: started at/gm) ?? []).length; } catch { return 0; } };
const unitPid = (u) => { try { return readFileSync(join(machine, 'units', `${u}@${world}.pid`), 'utf8').trim(); } catch { return null; } };
const claims = () => { try { return readdirSync(join(store, 'part', lineage, zone)).sort(); } catch { return []; } };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
// Settled: served, and no new claim or start for 5 s (a first start on a busy machine may restart once).
for (let i = 0, seen = '', since = Date.now(); i < 600; i++) {
  const now = `${claims().join()}|${starts()}|${existsSync(join(machine, 'data/run', `${world}.sock`))}`;
  if (now !== seen) { seen = now; since = Date.now(); } else if (now.endsWith('true') && Date.now() - since > 5000) break;
  await new Promise((r) => setTimeout(r, 100));
}

// Today's system, standing in: every world page and API answer is today's, as today's launcher answers.
const todayServer = createServer((req, res) => {
  if (req.url === '/sitemap.xml') return res.writeHead(200, { 'content-type': 'application/xml' }).end(`<?xml version="1.0"?><urlset><url><loc>https://soul.game/w/mars/</loc></url></urlset>`);
  const api = /\/v1\//.test(req.url);
  res.writeHead(200, { 'content-type': api ? 'application/json' : 'text/html', 'x-standin': 'today' }).end(api ? '{"ok":true,"system":"today"}' : '<!doctype html><title>today</title>');
}).listen(port.today, '127.0.0.1');
// The directory: W3's list, with Eden (and only Eden) on the new system.
const directory = createServer((req, res) => {
  if (req.url === '/v1/worlds') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ worlds: [{ name: 'eden', label: 'rehearsal', template: 'eden', lineage, zone: world.slice(33), creator: 'c', made: 0, awake: true, picture: null }], templates: ['eden'] }));
  res.writeHead(404).end();
}).listen(port.directory, '127.0.0.1');
stops.push(() => todayServer.close(), () => directory.close());

// The scratch host: /etc, the live release, today's data and the new system's under R, as standin.mjs lays them out.
const web = join(dir, 'web'), release = join(R, 'srv/sim-worlds/production'), src = join(release, 'v2/tools/ops/proxy'), shims = join(dir, 'bin');
for (const d of [join(R, 'etc/caddy/sites'), join(R, 'etc/sim-worlds'), join(R, 'etc/systemd/system', `worldd@${world}.service.d`), join(R, 'etc/souls'), join(R, 'var/lib/souls/directory'),
  join(R, 'srv/sim-worlds/data'), src, shims, join(web, 'src/home')]) mkdirSync(d, { recursive: true });
writeFileSync(join(web, 'index.html'), '<!doctype html><title>the new page</title>');
writeFileSync(join(web, 'src/home/index.html'), '<!doctype html><title>the one list</title>');
const names = (text) => text
  .replace(/^https:\/\/soul\.game \{/m, `http://127.0.0.1:${port.public} {`)
  .replace(/^https:\/\/sim\.eden\.art \{/m, `http://127.0.0.1:${port.primary} {`)
  .replace(/^https:\/\/souls\.game \{/m, `http://127.0.0.1:${port.public + 100} {`)
  .replaceAll('localhost:7310', `localhost:${port.directory}`).replaceAll('localhost:7320', `localhost:${port.origin}`).replaceAll('localhost:7330', `localhost:${port.origin}`)
  .replaceAll('/usr/local/lib/souls/web', web).replaceAll('/var/lib/souls/models', join(R, 'var/lib/souls/models')).replaceAll('/var/lib/souls-routes', join(R, 'var/lib/souls-routes')).replaceAll('/usr/bin/node', process.execPath)
  .replaceAll('/srv/sim-worlds/production/tools/world-launcher/deploy/caddy', today).replaceAll('/srv/sim-worlds/production', release);
for (const f of ['soul-game.caddy', 'souls-game.caddy', 'souls-routes.service', 'souls-routes.timer']) writeFileSync(join(src, f), names(readFileSync(join(ops, 'proxy', f), 'utf8')));
for (const f of ['routes.mjs', 'README.md']) writeFileSync(join(src, f), readFileSync(join(ops, 'proxy', f)));
writeFileSync(join(R, 'etc/sim-worlds/production.conf'), `SIM_WORLDS_ARGS="--port ${port.today} --data /srv/sim-worlds/data"\n`);
writeFileSync(join(R, 'srv/sim-worlds/data/feed.jsonl'), [
  { id: 'f1', at: '2026-11-18T12:00:00.000Z', kind: 'release', title: 'Soul 0.130', body: 'Release 0.130 is live.' },
  { id: 'f2', at: '2026-11-19T18:00:00.000Z', kind: 'announcement', title: 'Eden moves to the new engine', body: 'The rehearsal stands in for the owner notice.' },
].map((i) => JSON.stringify(i)).join('\n') + '\n');
writeFileSync(join(R, 'etc/caddy/cdn-trust.snippet'), readFileSync(join(today, 'cdn-trust.snippet')));
writeFileSync(join(R, 'etc/caddy/Caddyfile'), `{\n\tadmin localhost:${port.admin}\n\tauto_https off\n\timport cdn-trust.snippet\n}\nimport sites/*.caddy\n`);
for (const f of ['soul-game.caddy', 'sim-eden-art.caddy']) writeFileSync(join(R, 'etc/caddy/sites', f), names(readFileSync(join(today, f), 'utf8')).replaceAll('@@PRODUCTION_PORT@@', String(port.today)));
// The new system's settings as the switch-day checklist leaves them (scratch values: folders, no keys), Eden placed.
writeFileSync(join(R, 'etc/souls/cutover.env'), `SLUG=eden\nWORLD=${world}\n`);
writeFileSync(join(R, 'etc/souls/secrets.env'), [`SOULS_BACKUP_URL=folder:${join(dir, 'backup')}`, 'AWS_ACCESS_KEY_ID=scratch-only', 'AWS_SECRET_ACCESS_KEY=scratch-only',
  `SOULS_BACKUP_KEY_FILE=${join(dir, 'backup.key')}`, `WORLDD_STORE=folder:${store}`, ''].join('\n'));
writeFileSync(join(R, 'etc/systemd/system', `worldd@${world}.service.d`, 'place.conf'), `[Service]\nEnvironment=WORLDD_SOCKET=/var/lib/souls/run/${world}.sock\n`);
const accounts = join(R, 'var/lib/souls/directory/accounts.sqlite'), pairing = join(R, 'var/lib/souls/directory/pairing.sqlite');
writeFileSync(join(R, 'etc/souls/directory.args'), `DIRECTORYD_ARGS="--listen 127.0.0.1:${port.directory} --public-url https://soul.game --store ${accounts} --pairing ${pairing} --gateway-tokens /var/lib/souls/worlds/worlds/${world}/tokens"\n`);
// The world folder, as place-world.sh placed it: its tokens file is the one the directory writes (W11b's tokens.souls beside it).
mkdirSync(join(R, 'var/lib/souls/worlds/worlds', world), { recursive: true });
symlinkSync(join(machine, 'data/worlds/worlds', world, 'tokens'), join(R, 'var/lib/souls/worlds/worlds', world, 'tokens'));
const db = (p, sql) => { const d = new DatabaseSync(p); d.exec(sql); d.close(); };
db(accounts, 'CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL)');
db(pairing, `CREATE TABLE pair_requests_v1(code TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, device TEXT NOT NULL, label TEXT NOT NULL, soul TEXT,
  scope TEXT NOT NULL, force INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, account TEXT, grant_text TEXT, refusal TEXT, refusal_device TEXT)`);
let made = 0;
const someoneJoins = () => {   // a person who signs up and makes a Soul while Eden is on the new system
  made++;
  const s = Math.floor(Date.now() / 1000);
  db(accounts, `INSERT INTO provider_accounts_v1 VALUES ('acct_rehearsal_${made}', 'issuer', 'subject-${made}', ${s})`);
  db(pairing, `INSERT INTO pair_requests_v1(code, secret_hash, device, label, soul, scope, force, created_at, state) VALUES ('code${made}', 'hash${made}', 'device', 'label', NULL, 'soul', 0, ${s}, 'delivered')`);
};
// systemctl on the scratch host: a world's units are the scratch machine's; a reload is the scratch Caddy's; a start
// runs the unit's ExecStart; the rest does nothing.
const caddyfile = join(R, 'etc/caddy/Caddyfile');
writeFileSync(join(shims, 'systemctl'), `#!/bin/bash
u=; for x in "$@"; do case $x in *.service) u=\${x%.service} ;; esac; done
case "$*" in
  "reload caddy") exec caddy reload --config ${caddyfile} --address localhost:${port.admin} 2>/dev/null ;;
  "start souls-routes.service") eval "$(sed -n 's/^ExecStart=//p' ${join(R, 'etc/systemd/system/souls-routes.service')})" ;;
  is-active*) p=$(cat ${join(machine, 'units')}/$u.pid 2>/dev/null) && kill -0 "$p" 2>/dev/null ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
execFileSync('caddy', ['validate', '--config', caddyfile], { stdio: 'pipe' });
const caddy = spawn('caddy', ['run', '--config', caddyfile], { stdio: ['ignore', 'ignore', 'pipe'] });
caddy.stderr.resume();
stops.push(() => caddy.kill());
for (let i = 0; i < 100; i++) { try { await fetch(at(port.public) + '/robots.txt'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

// The front door's history: who serves Eden's page, every 100 ms, and whether both systems run.
const history = [];
let probing = true;
const system = (r) => r.headers.get('x-souls-system') ?? (r.headers.get('x-standin') === 'today' ? 'today' : `unknown ${r.status}`);
const probe = (async () => {
  while (probing) {
    let who;
    try { const r = await fetch(`${at(port.public)}/w/eden/`, { headers: { accept: 'text/html' } }); await r.arrayBuffer(); who = r.status === 200 ? system(r) : `refused ${r.status}`; } catch (e) { who = `unreachable ${e.cause?.code ?? e.message}`; }
    const both = alive(unitPid('worldd')) && (await fetch(`${at(port.today)}/w/mars/`).then((r) => r.ok, () => false));
    if (history.at(-1)?.who !== who || history.at(-1)?.both !== both) history.push({ at: clock(), who, both, n: 0 });
    history.at(-1).n++;
    await new Promise((r) => setTimeout(r, 100));
  }
})();

// Files under the scratch host changed by a command (path and size), to show what it touched.
const files = () => {
  const out = new Map(), walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else { const s = statSync(p); out.set(relative(R, p), `${s.size}:${s.mtimeMs}`); } } };
  walk(R);
  return out;
};
const touched = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k)).sort();
const cutover = async (cmd) => {   // spawned, not run synchronously: the stand-ins answer from this process
  const before = files(), start = Date.now();
  const p = spawn('bash', [join(here, 'cutover.sh'), cmd], { env: { ...process.env, CUTOVER_ROOT: R, CUTOVER_DIRECTORY: at(port.directory), PATH: `${shims}:${process.env.PATH}` } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((yes) => p.on('close', yes));
  const ms = Date.now() - start;
  for (const l of out.trim().split('\n').filter((x) => !x.startsWith('{"level":"info"'))) console.log(`    | ${l.replaceAll(dir, '<scratch>')}`);
  return { ok: code === 0, ms, touched: touched(before, files()) };
};
const check = async (title, want) => {
  const r = await frontCheck({ public: 'https://soul.game', v2: 'eden', today: 'mars', points: ['worlds'], map: { 'https://soul.game': at(port.public) } });
  log(`front-check worlds ${title}: ${r.pass ? 'PASS' : 'FAIL'} (want ${want ? 'PASS' : 'FAIL'}); ${r.seen.join('; ')}`);
  return r.pass === want;
};

const results = [], times = [];
let pass = false;
try {
  const claimsBefore = claims(), pidBefore = unitPid('worldd'), startsBefore = starts();
  log(`Eden's claims in the store before: epochs [${claimsBefore.map(Number).join(', ')}]; its process ${pidBefore ? 'running' : 'not running'}`);
  results.push(await check('before the switch', false));
  for (const round of [1, 2]) {
    log(`round ${round}: cutover.sh switch`);
    const s = await cutover('switch');
    log(`round ${round}: switch exit ${s.ok ? 0 : 1} in ${(s.ms / 1000).toFixed(2)} s; files changed: ${s.touched.join(', ')}`);
    results.push(s.ok, await check(`round ${round} switched`, true));
    someoneJoins();
    log(`round ${round}: while switched, someone signed up and made a Soul in the new system`);
    await new Promise((r) => setTimeout(r, 1500));
    log(`round ${round}: cutover.sh back`);
    const b = await cutover('back');
    log(`round ${round}: back exit ${b.ok ? 0 : 1} in ${(b.ms / 1000).toFixed(2)} s; files changed: ${b.touched.join(', ')}`);
    results.push(b.ok, await check(`round ${round} switched back`, false));
    times.push({ round, switch: s.ms, back: b.ms });
    const dns = [...s.touched, ...b.touched].filter((f) => !/^(etc\/caddy\/|etc\/systemd\/system\/souls-routes\.|var\/lib\/souls-routes\/|var\/lib\/souls\/(cutover\/log\.jsonl|news\.jsonl))/.test(f));
    log(`round ${round}: files outside the proxy, its map and the cut-over's own record: ${dns.length ? dns.join(', ') : 'none'} (no name's address is among them)`);
    results.push(dns.length === 0);
  }
  await new Promise((r) => setTimeout(r, 300));
  const claimsAfter = claims(), pidAfter = unitPid('worldd'), startsAfter = starts();
  const one = JSON.stringify(claimsAfter) === JSON.stringify(claimsBefore) && startsAfter === startsBefore && pidAfter === pidBefore && alive(pidAfter);
  log(`Eden's claims in the store after: epochs [${claimsAfter.map(Number).join(', ')}]; its process the same and running: ${pidAfter === pidBefore && alive(pidAfter)}; worldd starts ${startsBefore} before, ${startsAfter} after`);
  log(`one writer: ${one ? 'yes, no claim was added and the world never restarted' : 'NO'}`);
  results.push(one);
  probing = false;
  await probe;
  console.log('\nThe front door\'s history (who served /w/eden/, every 100 ms; "both" = both systems running):');
  for (const h of history) console.log(`  from ${h.at}: ${h.who}, both running ${h.both}, ${h.n} probes`);
  const flips = history.filter((h) => !['v2', 'today'].includes(h.who) || !h.both);
  log(`every probe answered by exactly one system with both running: ${flips.length ? `NO (${flips.map((h) => h.who).join(', ')})` : 'yes'}`);
  results.push(flips.length === 0, history.map((h) => h.who).join(',') === 'today,v2,today,v2,today');
  console.log('\n| round | switch (s) | back (s) |\n|---|---|---|');
  for (const t of times) console.log(`| ${t.round} | ${(t.switch / 1000).toFixed(2)} | ${(t.back / 1000).toFixed(2)} |`);
  pass = results.every(Boolean);
} finally {
  probing = false;
  for (const s of stops.reverse()) { try { await s(); } catch { /* stopping */ } }
  if (!a.includes('--keep')) rmSync(dir, { recursive: true, force: true });
}
console.log(pass ? 'rehearse: PASS (switch and back twice, one system serving at every moment, one writer, no DNS change)' : 'rehearse: FAIL');
process.exitCode = pass ? 0 : 1;
