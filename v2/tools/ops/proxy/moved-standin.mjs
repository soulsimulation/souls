#!/usr/bin/env node
// The front door while only some worlds have moved (soul-game-moved.caddy, moved-install.sh), proven on this machine.
// A scratch Caddy in the production layout (a Caddyfile importing the blobs snippet and sites/*.caddy) starts with a
// soul.game file shaped as the live one: /s/* to the viewers' origin, everything else to today's launcher. In front of:
//   - a new-engine world: N2's test world (`testworld`), `worldd seed` and `serve`, its `gatewayd`, a `directoryd`
//     with test sign-in, the viewers' origin and the agents' relay (v2/tools/origin) on a routes file naming it `eden`;
//   - today's launcher, a stand-in: it answers every request with its own name, and serves a moved world's client
//     files and /v1/config from a served-client build (v2/client/served/build.mjs) as the real launcher does.
// Then: (1) a fresh `node eden.mjs pair <front>/w/eden/` fails `pair-world-routing` (production's fault on 24 Nov);
// (2) moved-install.sh install, run as written with this machine's paths, swaps in the new file; (3) a fresh
// `eden.mjs pair` is approved through the front door, `act life:join` births a body in the new world through the
// front door's gateway path; (4) an old world's page, its pairing, its bootstrap and its v2 paths, and Eden's own page
// and client config, still reach today's launcher; (5) moved-install.sh undo puts the live file back and (1) again.
//   node v2/tools/ops/proxy/moved-standin.mjs     (BRAIN_MODE=fake is set for every process; nothing leaves loopback)
// Needs caddy on the path, and directoryd, gatewayd, worldd and testworld (v2/target/debug, or DIRECTORYD=... and so
// on) and replica's wasm-bindgen package (v2/target/wasm-load/pkg, or SOULS_REPLICA_PKG). Exit 0 when all of it holds.
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgents } from '../../origin/agents.mjs';
import { createOrigin } from '../../origin/origin.mjs';
import { build } from '../../../client/served/build.mjs';
import { answer } from '../../../client/served/serve.mjs';
import { request } from '../../../client/src/daemon/client.mjs';
import { runtimeOf } from '../../../client/src/home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url)), v2 = resolve(here, '../../..'), repo = resolve(v2, '..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
for (const f of [bin('directoryd'), bin('gatewayd'), bin('worldd'), bin('testworld'), join(PKG, 'replica.js')]) if (!existsSync(f)) throw Error(`missing ${f}`);
// the OS temp folder: worldd's sockets need a short path
const dir = mkdtempSync(join(tmpdir(), 'souls-moved-'));
const procs = [], log = (s) => console.log(`standin: ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
async function waitFor(what, f, ms = 30_000) {
  for (const until = Date.now() + ms; ;) { const v = await f(); if (v) return v; if (Date.now() > until) throw Error(`timed out: ${what}`); await sleep(50); }
}
function run(path, args, ready, opts = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { PATH: process.env.PATH, BRAIN_MODE: 'fake', ...opts.env } });
  procs.push(p);
  let out = '';
  const done = new Promise((ok, fail) => {
    const take = (d) => { out += d; const m = ready?.exec(out); if (m) ok({ p, m }); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('exit', (c) => (ready ? fail(Error(`${path} ended (${c}) before it was ready: ${out.slice(-1500)}`)) : ok({ code: c, out })));
  });
  done.text = () => out;
  return done;
}
const stopAll = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch { /* gone */ } if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stopAll);

// ---- the new-engine world, as `eden` --------------------------------------------------------------------------
const made = await run(bin('testworld'), ['--seed', '1', '--things', '0', '--out', dir]);
if (made.code !== 0) throw Error(made.out);
const world = join(dir, 'world');
const seeded = await run(bin('worldd'), ['seed', '--facts', join(dir, 'testworld-s1-t0.facts.json'), '--dir', world, '--souls', '0', '--at', '0,0']);
if (seeded.code !== 0) throw Error(seeded.out);
await run(bin('worldd'), ['serve', '--dir', world], /listening /);
const gwPort = await freePort(), front = await freePort(), admin = await freePort();
const FRONT = `http://127.0.0.1:${front}`;
await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(world, 'gateway.sock'), '--tokens', join(world, 'tokens'),
  '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', FRONT, '--store', join(dir, 'accounts.sqlite'),
  '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'), '--gateway-tokens', join(world, 'tokens')], /listening on (\S+)\n/);
const directory = m[1];
const routes = join(dir, 'worlds.json');
writeFileSync(routes, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { gateway: `http://127.0.0.1:${gwPort}`, stream: '/s/eden/', canonical: true } } }));
const streams = join(dir, 'streams');
mkdirSync(join(streams, 'eden'), { recursive: true });
writeFileSync(join(streams, 'eden', 'marker.txt'), 'the viewers origin\n');
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const originPort = await listen(createOrigin(streams, { worldRoutes: routes }).server);
const agentsPort = await listen(createAgents(routes).server);

// ---- today's launcher, a stand-in --------------------------------------------------------------------------------
const client = join(dir, 'client');
build({ out: client, version: '0.0.0', pkg: PKG });
const oldSeen = [];
const launcherPort = await listen(createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  oldSeen.push(`${req.method} ${path}`);
  const a = req.method === 'GET' && path.startsWith('/w/eden/') ? answer(client, path) : null;   // as cutover.mjs answers a moved world's client
  if (a) { res.writeHead(a.status, { 'content-type': a.type, 'content-length': a.body.length, 'x-stand-in': 'old-launcher' }); res.end(a.body); return; }
  res.writeHead(path === '/' || path.endsWith('/') ? 200 : 404, { 'content-type': 'application/json', 'x-stand-in': 'old-launcher' }).end(JSON.stringify({ standIn: 'old-launcher', path }));
}));
log(`eden: directory ${directory}, gateway ${gwPort}, origin ${originPort}, relay ${agentsPort}; old launcher ${launcherPort}; front door ${FRONT}`);

// ---- the scratch Caddy, in the live layout ---------------------------------------------------------------------------
const etc = join(dir, 'caddy'), web = join(dir, 'web');
mkdirSync(join(etc, 'sites'), { recursive: true }); mkdirSync(web);
writeFileSync(join(web, 'pair.html'), '<!doctype html><title>pairing card</title>');
copyFileSync(join(repo, 'tools/world-launcher/deploy/blobs/sim-blobs.snippet'), join(etc, 'sim-blobs.snippet'));
writeFileSync(join(etc, 'Caddyfile'), `{\n\tadmin 127.0.0.1:${admin}\n\tauto_https off\n\tstorage file_system ${join(etc, 'data')}\n}\nimport ${join(etc, 'sim-blobs.snippet')}\nimport sites/*.caddy\n`);
// The live 0.131 F0 soul.game file's shape (production's addresses swapped for this machine's)
const live = `http://127.0.0.1:${front} {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    -Server
  }
  import blobs
  handle_path /s/* {
    header X-Souls-System v2
    reverse_proxy localhost:${originPort}
  }
  handle {
    reverse_proxy 127.0.0.1:${launcherPort} {
      trusted_proxies private_ranges
    }
  }
}
`;
writeFileSync(join(etc, 'sites/soul-game.caddy'), live);
const caddyEnv = { HOME: dir, XDG_DATA_HOME: join(etc, 'data'), XDG_CONFIG_HOME: join(etc, 'config') };
await run('caddy', ['run', '--config', join(etc, 'Caddyfile'), '--adapter', 'caddyfile'], /serving initial configuration/, { cwd: etc, env: caddyEnv });
log('scratch Caddy up with the live-shaped file');

// ---- the checks ------------------------------------------------------------------------------------------------
const get = async (path, init) => { const r = await fetch(FRONT + path, { redirect: 'manual', ...init }); return { status: r.status, sys: r.headers.get('x-souls-system'), old: r.headers.get('x-stand-in') === 'old-launcher', body: await r.text() }; };
const eden = (home, ...args) => new Promise((ok) => {
  const p = spawn(process.execPath, [join(home, '..', 'eden.mjs'), ...args], { cwd: dirname(home), env: { PATH: process.env.PATH, SOULS_HOME: home, BRAIN_MODE: 'fake' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('exit', () => { const last = out.trim().split('\n').at(-1); try { ok(JSON.parse(last)); } catch { ok({ ok: false, raw: out.slice(-800) }); } });
});
let n = 0;
const freshHome = () => { const f = join(dir, `soul-${++n}`); mkdirSync(f); copyFileSync(join(client, 'eden.mjs'), join(f, 'eden.mjs')); return join(f, '.souls'); };

async function pairFails(when) {
  const r = await eden(freshHome(), 'pair', `${FRONT}/w/eden/`);
  check(r.ok === false && r.code === 'pair-world-routing', `${when}: a fresh \`eden.mjs pair ${FRONT}/w/eden/\` fails pair-world-routing (${r.code ?? JSON.stringify(r).slice(0, 200)})`);
}
await pairFails('live-shaped file');

// install, as the release owner runs it, with this machine's paths
const env = { PATH: process.env.PATH, ETC: etc, SAVED: join(etc, 'soul-game.caddy.before-moved'), SITE: `http://127.0.0.1:${front}`, FRONT,
  DIRECTORY: directory, ORIGIN: `127.0.0.1:${originPort}`, AGENTS: `127.0.0.1:${agentsPort}`, WEB: web, ...caddyEnv,
  RELOAD: `caddy reload --config ${join(etc, 'Caddyfile')} --adapter caddyfile --address 127.0.0.1:${admin}` };
// asynchronous: the origin, the relay and the launcher stand-in answer from this process while the script runs
const sh = (a, extra = {}) => new Promise((ok) => execFile('bash', [join(here, 'moved-install.sh'), a], { env: { ...env, ...extra } }, (e, out, err) => ok({ code: e ? e.code : 0, out: `${out}${err}` })));
const installed = await sh('install');
console.log(installed.out.trim());
check(installed.code === 0, 'moved-install.sh install: saved, validated, reloaded, checked');
check(existsSync(join(etc, 'soul-game.caddy.before-moved')) && readFileSync(join(etc, 'soul-game.caddy.before-moved'), 'utf8') === live, 'the live file is saved byte for byte');

// (3) a fresh pair, approved through the front door, and a join through the front door's gateway path
const home = freshHome();
const asked = await eden(home, 'pair', `${FRONT}/w/eden/`);
check(asked.ok !== false && typeof asked.code === 'string', `a fresh \`eden.mjs pair ${FRONT}/w/eden/\` asks the directory (code ${asked.code}, link ${asked.link})`);
const show = await get('/pair?code=' + asked.code);
check(show.status === 200 && show.sys === 'v2' && show.body.includes('pairing card'), `the pairing link's card /pair comes from the release's web build (${show.status} ${show.sys})`);
const approve = await fetch(`${FRONT}/v1/pair/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'owner' }) });
check(approve.status === 200 && approve.headers.get('x-souls-system') === 'v2', `the owner's approval, POST /v1/pair/approve through the front door, reaches the directory (${approve.status})`);
const cfg = await waitFor('the pairing token', () => { try { const c = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')); return Object.keys(c.souls ?? {}).length ? c : null; } catch { return null; } });
const soul = Object.keys(cfg.souls)[0];
const worlds = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).worlds;
check(worlds.eden?.gateway === `ws://127.0.0.1:${front}/w/eden/v2/ws` && worlds.eden?.url === FRONT, `the Soul ${soul} is paired for eden through the front door: gateway ${worlds.eden?.gateway}`);
const sent = await eden(home, 'act', 'life:join', '--soul', soul);
check(sent.ok === true && Number.isInteger(sent.sequence), `\`eden.mjs act life:join\` is sent (${JSON.stringify(sent).slice(0, 160)})`);
const rt = runtimeOf(home, soul), seen = [];
const joined = await waitFor('the join\'s answer', async () => { seen.push(...(await request(rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer')); return seen.find((e) => e.sequence === sent.sequence); });
check(joined.answer === 1 || joined.answer === 3, `the world answers the join through ${FRONT}/w/eden/v2/ws (answer ${joined.answer}: ${joined.answer === 1 ? 'receipt' : 'accepted'})`);
const look = await eden(home, 'find', 'body', '--soul', soul);
const body = look.found?.find((r) => r.kind?.startsWith('souls:body'));
check(!!body, `the Soul's body is in its copy of the new world (${body?.id} ${body?.kind})`);
await request(rt.socket, { op: 'stop' }).catch(() => {});

// (4) what must stay with today's launcher
oldSeen.length = 0;
for (const [path, init, what] of [
  ['/', undefined, 'the home page'],
  ['/w/mars-college-2027/', undefined, 'an old world\'s page'],
  ['/w/mars-college-2027/v1/agent/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"x"}' }, 'an old world\'s pairing (today\'s client)'],
  ['/w/mars-college-2027/v1/bootstrap', undefined, 'an old world\'s bootstrap'],
  ['/w/mars-college-2027/v2/ws', undefined, 'an old world\'s v2 socket path'],
  ['/w/eden-2026/v1/bootstrap', undefined, 'a slug that only begins with a moved one'],
  ['/w/eden/', undefined, 'Eden\'s own page (the launcher serves a moved world\'s page)'],
  ['/w/eden/v1/me', undefined, 'Eden\'s other old routes'],
  ['/v1/account/souls', { method: 'POST' }, 'the site\'s account API'],
]) {
  const r = await get(path, init);
  check(r.old && r.sys === null, `${what}, ${init?.method ?? 'GET'} ${path}: today's launcher (${r.status})`);
}
const conf = await get('/w/eden/v1/config');
check(conf.old && JSON.parse(conf.body).soulClient?.version === '0.0.0', 'Eden\'s /v1/config, the served client\'s, still comes from today\'s launcher');
const s = await get('/s/eden/marker.txt');
check(s.status === 200 && s.sys === 'v2' && s.body.startsWith('the viewers origin'), '/s/* still reaches the viewers\' origin');
for (const path of ['/w/eden/v1/bootstrap', '/v1/pair/show']) {
  const r = await get(path, path.startsWith('/v1') ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined);
  check(r.sys === 'v2' && !r.old, `${path}: the new system (${r.status})`);
}

// (5) undo
const undone = await sh('undo');
console.log(undone.out.trim());
check(undone.code === 0 && readFileSync(join(etc, 'sites/soul-game.caddy'), 'utf8') === live, 'moved-install.sh undo: the live file is back, validated, reloaded');
await pairFails('after undo');

// a broken source never reaches Caddy: validate fails, the saved file stays, no reload
writeFileSync(join(dir, 'broken.caddy'), readFileSync(join(here, 'soul-game-moved.caddy'), 'utf8').replace('handle @card {', 'handle @card {\n    no_such_directive\n'));
const broken = await sh('install', { SRC: join(dir, 'broken.caddy') });
check(broken.code !== 0 && /validate failed/.test(broken.out) && readFileSync(join(etc, 'sites/soul-game.caddy'), 'utf8') === live, 'a file that fails `caddy validate` is not installed and Caddy is not reloaded');
await pairFails('after the refused install');

console.log(failures.length ? `standin: ${failures.length} failed` : 'standin: all passed');
stopAll();
process.exit(failures.length ? 1 : 0);
