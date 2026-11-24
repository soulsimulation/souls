#!/usr/bin/env node
// The front door while only some worlds have moved (soul-game-moved.caddy, moved-install.sh), proven on this machine.
// A scratch Caddy in the production layout (a Caddyfile importing the blobs snippet and sites/*.caddy) starts with a
// soul.game file shaped as the live one: /s/* to the viewers' origin, everything else to today's launcher. In front of:
//   - two new-engine worlds, `eden` and `hamlet`: N2's test world (`testworld`), each with its own `worldd seed` and
//     `serve` and its own `gatewayd` (with its own receipts folder), one `directoryd` with test sign-in, and the
//     viewers' origin (v2/tools/origin) on a routes file naming both gateways, as production's worlds.json does;
//   - today's launcher, a stand-in: it answers every request with its own name, and serves a moved world's client
//     files and /v1/config from a served-client build (v2/client/served/build.mjs) as the real launcher does.
// Then: (0) a fresh `node eden.mjs pair <front>/w/eden/` fails `pair-world-routing` (production's fault at 07:15),
// and the file #4520 installed answers /w/eden/v2/ws 404 from Eden's gatewayd (production's fault at 08:34);
// (1) moved-install.sh refuses a line that names another world's gateway port; (2) moved-install.sh install, run as
// written with this machine's paths, swaps in the new file; (3) for each world, a fresh `eden.mjs pair` is approved
// through the front door, its /w/<slug>/v2/ws opens (101) and `act life:join` gets its receipt from THAT world's
// gatewayd, never the other's; (4) an old world's page, its pairing, its bootstrap and its v2 paths, and Eden's own
// page and client config, still reach today's launcher; (5) moved-install.sh undo puts the live file back.
//   node v2/tools/ops/proxy/moved-standin.mjs     (BRAIN_MODE=fake is set for every process; nothing leaves loopback)
// Needs caddy on the path, and directoryd, gatewayd, worldd and testworld (v2/target/debug, or DIRECTORYD=... and so
// on) and replica's wasm-bindgen package (v2/target/wasm-load/pkg, or SOULS_REPLICA_PKG). Exit 0 when all of it holds.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect as netConnect, createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'souls-moved-')));
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
    let up = false;
    const take = (d) => { out += d; const m = !up && ready?.exec(out); if (m) { up = true; ok({ p, m }); } };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('exit', (c) => (up ? stopping || log(`${path} ended (${c}): ${out.slice(-600)}`) : ready ? fail(Error(`${path} ended (${c}) before it was ready: ${out.slice(-1500)}`)) : ok({ code: c, out })));
  });
  done.text = () => out;
  return done;
}
let stopping = false;
const stopAll = () => { stopping = true; for (const p of procs) try { p.kill('SIGKILL'); } catch { /* gone */ } if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stopAll);

// ---- two new-engine worlds, `eden` and `hamlet`, each with its own gatewayd ----------------------------------------
const made = await run(bin('testworld'), ['--seed', '1', '--things', '0', '--out', dir]);
if (made.code !== 0) throw Error(made.out);
const front = await freePort(), tls = await freePort(), admin = await freePort();
const FRONT = `http://127.0.0.1:${front}`;
// One directory for both, as production has. Production's directory keeps a tokens file per world (its world-authority
// map, which needs the world store); this one keeps one, in Eden's folder, and hamlet's gatewayd reads it through a
// link, so a token alone would open either world. Which world a join reached is told by each gateway's receipts.
const W = {};
for (const slug of ['eden', 'hamlet']) {
  const world = join(dir, slug);
  const seeded = await run(bin('worldd'), ['seed', '--facts', join(dir, 'testworld-s1-t0.facts.json'), '--dir', world, '--souls', '0', '--at', '0,0']);
  if (seeded.code !== 0) throw Error(seeded.out);
  await run(bin('worldd'), ['serve', '--dir', world], /listening /);
  const tokens = join(world, 'tokens');
  if (slug !== 'eden') { rmSync(tokens, { force: true }); symlinkSync(join(dir, 'eden', 'tokens'), tokens); }
  const port = await freePort(), receipts = join(dir, `${slug}-receipts`);
  await run(bin('gatewayd'), ['--listen', `127.0.0.1:${port}`, '--world', join(world, 'gateway.sock'), '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', receipts], /listening (\S+)\n/);
  const count = () => { try { return readdirSync(receipts).flatMap((f) => readFileSync(join(receipts, f), 'utf8').trim().split('\n')).filter(Boolean).length; } catch { return 0; } };
  W[slug] = { port, count };
}
const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', FRONT, '--store', join(dir, 'accounts.sqlite'),
  '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'), '--gateway-tokens', join(dir, 'eden', 'tokens')], /listening on (\S+)\n/);
const directory = m[1];
const routes = join(dir, 'worlds.json');
writeFileSync(routes, JSON.stringify({ schema: 'souls/world-routes/1', worlds: Object.fromEntries(Object.entries(W).map(([slug, w]) => [slug, { gateway: `http://127.0.0.1:${w.port}`, stream: `/s/${slug}/`, canonical: slug === 'eden' }])) }));
const streams = join(dir, 'streams');
mkdirSync(join(streams, 'eden'), { recursive: true });
writeFileSync(join(streams, 'eden', 'marker.txt'), 'the viewers origin\n');
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const originPort = await listen(createOrigin(streams, { worldRoutes: routes }).server);

// ---- today's launcher, a stand-in --------------------------------------------------------------------------------
const client = join(dir, 'client');
build({ out: client, version: '0.0.0', pkg: PKG });
const launcherPort = await listen(createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const a = req.method === 'GET' && /^\/w\/(eden|hamlet)\//.test(path) ? answer(client, path) : null;   // as cutover.mjs answers a moved world's client
  if (a) { res.writeHead(a.status, { 'content-type': a.type, 'content-length': a.body.length, 'x-stand-in': 'old-launcher' }); res.end(a.body); return; }
  const pageOf = /^\/w\/(eden|hamlet)\/$/.exec(path)?.[1];
  if (pageOf) {   // the page with its inline config, as the real launcher writes a moved world's page (page-meta.mjs)
    const config = { worldKey: pageOf, worldId: `${pageOf}-world`, worldPath: `/w/${pageOf}`, v2Stream: `/s/${pageOf}/` };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-stand-in': 'old-launcher' }).end(`<!doctype html><head><script>window.__simConfig=${JSON.stringify(config)}</script></head><body></body>`);
    return;
  }
  res.writeHead(path === '/' || path.endsWith('/') ? 200 : 404, { 'content-type': 'application/json', 'x-stand-in': 'old-launcher' }).end(JSON.stringify({ standIn: 'old-launcher', path }));
}));
log(`directory ${directory}, eden's gatewayd ${W.eden.port}, hamlet's ${W.hamlet.port}, origin ${originPort}; old launcher ${launcherPort}; front door ${FRONT}`);

// ---- the scratch Caddy, in the live layout ---------------------------------------------------------------------------
const etc = join(dir, 'caddy'), web = join(dir, 'web');
mkdirSync(join(etc, 'sites'), { recursive: true }); mkdirSync(web);
writeFileSync(join(web, 'pair.html'), '<!doctype html><title>pairing card</title>');
copyFileSync(join(repo, 'tools/world-launcher/deploy/blobs/sim-blobs.snippet'), join(etc, 'sim-blobs.snippet'));
writeFileSync(join(etc, 'Caddyfile'), `{\n\tadmin 127.0.0.1:${admin}\n\tauto_https disable_redirects\n\tlocal_certs\n\tskip_install_trust\n\tstorage file_system ${join(etc, 'data')}\n}\nimport ${join(etc, 'sim-blobs.snippet')}\nimport sites/*.caddy\n`);
// The live 0.131 F0 soul.game file's shape (production's addresses swapped for this machine's)
const live = `http://127.0.0.1:${front}, https://localhost:${tls} {
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
const reload = `caddy reload --config ${join(etc, 'Caddyfile')} --adapter caddyfile --address 127.0.0.1:${admin}`;
const reloaded = () => new Promise((ok) => execFile('bash', ['-c', reload], { env: { PATH: process.env.PATH, ...caddyEnv } }, ok));

// ---- the checks ------------------------------------------------------------------------------------------------
const get = async (path, init) => { const r = await fetch(FRONT + path, { redirect: 'manual', ...init }); return { status: r.status, sys: r.headers.get('x-souls-system'), old: r.headers.get('x-stand-in') === 'old-launcher', body: await r.text() }; };
/** A WebSocket upgrade of `path` through the front door: the answer's status (101 when a socket opens). */
const upgrade = (path) => new Promise((ok) => {
  const c = netConnect(front, '127.0.0.1', () => c.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${front}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`));
  let got = '';
  c.on('data', (d) => { got += d; if (got.includes('\r\n')) { c.destroy(); ok(Number(got.split(' ')[1])); } });
  c.on('error', () => ok(0));
});
const eden = (home, ...args) => cli(join(home, '..', 'eden.mjs'), home, ...args);
const cli = (file, home, ...args) => new Promise((ok) => {
  const p = spawn(process.execPath, [file, ...args], { cwd: dirname(home), env: { PATH: process.env.PATH, SOULS_HOME: home, BRAIN_MODE: 'fake', SOULS_REPLICA_PKG: PKG } });
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
// (0) production's two faults
await pairFails('live-shaped file');
const was = execFileSync('git', ['-C', repo, 'show', '15bbffc12:v2/tools/ops/proxy/soul-game-moved.caddy'], { encoding: 'utf8' })
  .replace(/^https:\/\/soul\.game \{/m, `${FRONT} {`).replaceAll('@@TRUSTED_PROXIES@@', 'private_ranges').replaceAll('@@LAUNCHER_PORT@@', String(launcherPort))
  .replaceAll('localhost:7310', directory).replaceAll('localhost:7320', `127.0.0.1:${originPort}`).replaceAll('localhost:7330', `127.0.0.1:${W.eden.port}`)
  .replace('^/w/(eden)/', '^/w/(eden|hamlet)/').replaceAll('/srv/sim-worlds/production/apps/web/dist', web);
writeFileSync(join(etc, 'sites/soul-game.caddy'), was);
await reloaded();
check(await upgrade('/w/eden/v2/ws') === 404, '#4520\'s file, its 7330 being Eden\'s gatewayd: /w/eden/v2/ws is 404 (production\'s fault at 08:34)');
writeFileSync(join(etc, 'sites/soul-game.caddy'), live);
await reloaded();

// The repo file with this machine's worlds in its lines: eden canonical (moved-world), hamlet not (moved-gateway); one
// that sends hamlet to Eden's gatewayd; and one that moves hamlet's bootstrap although it is not canonical
const withLines = (rows) => readFileSync(join(here, 'soul-game-moved.caddy'), 'utf8')
  .replace(/( {2}import moved-(world|gateway) [a-z0-9-]+ \d+\n)+/, rows.map(([kind, s, p]) => `  import moved-${kind} ${s} ${p}\n`).join(''));
writeFileSync(join(dir, 'moved.caddy'), withLines([['world', 'eden', W.eden.port], ['gateway', 'hamlet', W.hamlet.port]]));
writeFileSync(join(dir, 'crossed.caddy'), withLines([['world', 'eden', W.eden.port], ['gateway', 'hamlet', W.eden.port]]));
writeFileSync(join(dir, 'kind.caddy'), withLines([['world', 'eden', W.eden.port], ['world', 'hamlet', W.hamlet.port]]));

// (1), (2) install, as the release owner runs it, with this machine's paths
const env = { PATH: process.env.PATH, ETC: etc, SAVED: join(etc, 'soul-game.caddy.before-moved'), // The script checks the front door over HTTPS, where curl negotiates HTTP/2 as it does against soul.game: the installed
  // site also answers on https://localhost:<tls> (Caddy's own local CA, trusted only by this run's curl)
  SITE: FRONT, SITE_LINE: `${FRONT}, https://localhost:${tls}`, FRONT: `https://localhost:${tls}`, CURL_CA: join(etc, 'data', 'pki', 'authorities', 'local', 'root.crt'), DIRECTORY: directory,
  ORIGIN: `127.0.0.1:${originPort}`, ROUTES: routes, WEB: web, SRC: join(dir, 'moved.caddy'), ...caddyEnv, RELOAD: reload };
// asynchronous: the origin and the launcher stand-in answer from this process while the script runs
const sh = (a, extra = {}) => new Promise((ok) => execFile('bash', [join(here, 'moved-install.sh'), a], { env: { ...env, ...extra } }, (e, out, err) => ok({ code: e ? e.code : 0, out: `${out}${err}` })));
const crossed = await sh('install', { SRC: join(dir, 'crossed.caddy') });
check(crossed.code !== 0 && crossed.out.includes(`hamlet: the line says gatewayd on port ${W.eden.port}, but ${routes} says 'http://127.0.0.1:${W.hamlet.port}'`)
  && readFileSync(join(etc, 'sites/soul-game.caddy'), 'utf8') === live && !existsSync(env.SAVED), 'a line that sends hamlet to Eden\'s gatewayd is refused, nothing changed');
const kind = await sh('install', { SRC: join(dir, 'kind.caddy') });
check(kind.code !== 0 && kind.out.includes(`hamlet: canonical is false in ${routes}, so its line is 'import moved-gateway hamlet ${W.hamlet.port}'`)
  && readFileSync(join(etc, 'sites/soul-game.caddy'), 'utf8') === live, 'a line that moves the bootstrap of a world that is not canonical is refused, nothing changed');
const listed = await sh('lines');
console.log(listed.out.trim());
check(listed.out.includes(`import moved-world eden ${W.eden.port}`) && listed.out.includes(`import moved-gateway hamlet ${W.hamlet.port}`)
  && listed.out.includes('# hamlet: bootstrap stays on the launcher (not canonical)'), '`moved-install.sh lines` gives eden moved-world and hamlet moved-gateway, saying why');
const installed = await sh('install');
console.log(installed.out.trim());
check(installed.code === 0, 'moved-install.sh install: saved, validated, reloaded, checked');
// The script's own front-door checks went over HTTPS, where curl speaks HTTP/2 to this Caddy as to soul.game
const h2 = await new Promise((ok) => execFile('curl', ['-sI', '--cacert', env.CURL_CA, `${env.FRONT}/`], (e, out) => ok(String(out).split('\n')[0].trim())));
check(h2.startsWith('HTTP/2') && ['eden', 'hamlet'].every((w) => installed.out.includes(`front door /w/${w}/v2/ws: 101`)),
  `the script's socket checks through ${env.FRONT} (${h2}) got 101 for both worlds`);
check(['eden', 'hamlet'].every((w) => installed.out.includes(`front door /w/${w}/ page config: ok`)) && installed.out.includes('front door /w/hamlet/v1/bootstrap (not canonical): 404 today'),
  'after the reload both pages load their own config, and hamlet\'s bootstrap stays on the launcher');
check(existsSync(env.SAVED) && readFileSync(env.SAVED, 'utf8') === live, 'the live file is saved byte for byte');
const put = readFileSync(join(etc, 'sites/soul-game.caddy'), 'utf8').split('\n').filter((l) => /^\s*#/.test(l));
check(!put.some((l) => l.includes('private_ranges') || l.includes(String(launcherPort))), 'the installed file\'s comments carry no host values');

// (3) for each world: a fresh pair approved through the front door, and a join that reaches that world's own gatewayd
for (const [slug, other] of [['eden', 'hamlet'], ['hamlet', 'eden']]) {
  const home = freshHome();
  let asked;
  if (slug === 'eden') {
    asked = await eden(home, 'pair', `${FRONT}/w/${slug}/`);
    check(asked.ok !== false && typeof asked.code === 'string', `${slug}: a fresh \`eden.mjs pair ${FRONT}/w/${slug}/\` asks the directory (code ${asked.code}, link ${asked.link})`);
  } else {
    // not canonical: its bootstrap is the launcher's, so the world URL does not pair (by design, until it is canonical);
    // pair.mjs, with the directory and the gateway named, pairs through the front door all the same
    const r = await eden(home, 'pair', `${FRONT}/w/${slug}/`);
    check(r.code === 'pair-world-routing', `${slug}: not canonical, so \`eden.mjs pair ${FRONT}/w/${slug}/\` gets pair-world-routing (${r.code})`);
    const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', FRONT, '--world', slug, '--gateway', `ws://127.0.0.1:${front}/w/${slug}/v2/ws`,
      '--device', 'stand-in', '--label', 'stand-in'], null, { cwd: dirname(home), env: { SOULS_HOME: home } });
    asked = await waitFor('the pairing code', () => asking.text().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.code));
    check(typeof asked.code === 'string', `${slug}: pair.mjs through the front door asks the directory (code ${asked.code})`);
  }
  const show = await get('/pair?code=' + asked.code);
  check(show.status === 200 && show.sys === 'v2' && show.body.includes('pairing card'), `${slug}: the pairing link's card /pair comes from the release's web build (${show.status} ${show.sys})`);
  const approve = await fetch(`${FRONT}/v1/pair/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'owner' }) });
  check(approve.status === 200 && approve.headers.get('x-souls-system') === 'v2', `${slug}: the owner's approval, POST /v1/pair/approve through the front door, reaches the directory (${approve.status})`);
  const cfg = await waitFor('the pairing token', () => { try { const c = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')); return Object.keys(c.souls ?? {}).length ? c : null; } catch { return null; } });
  const soul = Object.keys(cfg.souls)[0];
  const worlds = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).worlds;
  check(worlds[slug]?.gateway === `ws://127.0.0.1:${front}/w/${slug}/v2/ws` && worlds[slug]?.url === FRONT, `${slug}: the Soul ${soul} is paired through the front door: gateway ${worlds[slug]?.gateway}`);
  const status = await upgrade(`/w/${slug}/v2/ws`);
  check(status === 101, `${slug}: ${FRONT}/w/${slug}/v2/ws opens a socket (${status})`);
  const before = { mine: W[slug].count(), other: W[other].count() };
  const sent = await eden(home, 'act', 'life:join', '--soul', soul);
  check(sent.ok === true && Number.isInteger(sent.sequence), `${slug}: \`eden.mjs act life:join\` is sent (sequence ${sent.sequence})`);
  const rt = runtimeOf(home, soul), seen = [];
  const joined = await waitFor('the join\'s answer', async () => { seen.push(...(await request(rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer')); return seen.find((e) => e.sequence === sent.sequence); });
  check(joined.answer === 1, `${slug}: the world answers the join with its receipt (answer ${joined.answer})`);
  await waitFor(`${slug}'s gatewayd's receipt`, () => W[slug].count() > before.mine, 10_000).catch(() => null);
  check(W[slug].count() === before.mine + 1 && W[other].count() === before.other,
    `${slug}: the join's receipt is in ${slug}'s gatewayd (${before.mine} -> ${W[slug].count()}), none in ${other}'s (${before.other} -> ${W[other].count()})`);
  const look = await eden(home, 'find', 'body', '--soul', soul);
  const body = look.found?.find((r) => r.kind?.startsWith('souls:body'));
  check(!!body, `${slug}: the Soul's body is in its copy of the world (${body?.id} ${body?.kind})`);
  await request(rt.socket, { op: 'stop' }).catch(() => {});
}

// (4) what must stay with today's launcher
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
check(await upgrade('/w/mars-college-2027/v2/ws') !== 101, 'an old world\'s /v2/ws upgrade opens no new-engine socket');
const conf = await get('/w/eden/v1/config');
check(conf.old && JSON.parse(conf.body).soulClient?.version === '0.0.0', 'Eden\'s /v1/config, the served client\'s, still comes from today\'s launcher');
const s = await get('/s/eden/marker.txt');
check(s.status === 200 && s.sys === 'v2' && s.body.startsWith('the viewers origin'), '/s/* still reaches the viewers\' origin');
const hb = await get('/w/hamlet/v1/bootstrap');
check(hb.old && hb.sys === null, `hamlet's bootstrap (not canonical) stays with today's launcher (${hb.status})`);
for (const path of ['/w/eden/v1/bootstrap', '/v1/pair/show', '/v1/account/view-token', '/v1/account/requests/x']) {   // the page's sign-in exchange, the card's login approval
  const r = await get(path, path.startsWith('/v1') ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined);
  check(r.sys === 'v2' && !r.old, `${path}: the new system (${r.status})`);
}

// (5) undo
const undone = await sh('undo');
console.log(undone.out.trim());
check(undone.code === 0 && readFileSync(join(etc, 'sites/soul-game.caddy'), 'utf8') === live, 'moved-install.sh undo: the live file is back, validated, reloaded');
await pairFails('after undo');

// a broken source never reaches Caddy: validate fails, the saved file stays, no reload
writeFileSync(join(dir, 'broken.caddy'), readFileSync(join(dir, 'moved.caddy'), 'utf8').replace('handle @card {', 'handle @card {\n    no_such_directive\n'));
const broken = await sh('install', { SRC: join(dir, 'broken.caddy') });
check(broken.code !== 0 && /validate failed/.test(broken.out) && readFileSync(join(etc, 'sites/soul-game.caddy'), 'utf8') === live, 'a file that fails `caddy validate` is not installed and Caddy is not reloaded');
await pairFails('after the refused install');

console.log(failures.length ? `standin: ${failures.length} failed` : 'standin: all passed');
stopAll();
process.exit(failures.length ? 1 : 0);
