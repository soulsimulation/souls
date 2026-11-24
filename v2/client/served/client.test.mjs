// The served client, end to end (Engine v2 R17, #2818): a world's address serving what v2/client/served/build.mjs
// built (`serve.mjs`'s `answer`, the rest passed to the real directory), the real gateway and the world's stand-in end
// of it (`worldd gateway-link`). Run from v2/ after
//   cargo build -p directoryd -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request } from '../src/daemon/client.mjs';
import { runtimeOf } from '../src/home/home.mjs';
import { build } from './build.mjs';
import { answer } from './serve.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'souls-r17-'));
const procs = [];
const sha = (b) => createHash('sha256').update(b).digest('hex');

function run(path, args, ready, opts = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (ready?.exec(out)) ok({ p, m: ready.exec(out) }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => (ready ? fail(new Error(`${path} ended (${c}): ${out}`)) : ok({ p, out, code: c })));
  });
}
async function waitFor(f, ms = 30_000) {
  for (const until = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(25);
  }
}
const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

// The world's address: `serving` is the folder its served files come from; `redirect` answers 302 for /v1/config.
let directory, world, arrivals, tokensFile, site, serving, redirect = false, server;
const served = {};

before(async () => {
  served.v1 = join(dir, 'served-1.0.0');
  served.v2 = join(dir, 'served-1.1.0');
  served.bad = join(dir, 'served-bad');
  build({ out: served.v1, version: '1.0.0', pkg: PKG });
  build({ out: served.v2, version: '1.1.0', pkg: PKG });
  // The changed bundle: 1.2.0's description, with one byte of its client changed.
  build({ out: served.bad, version: '1.2.0', pkg: PKG });
  const b = readFileSync(join(served.bad, 'eden.mjs'));
  b[b.length - 2] ^= 1;
  writeFileSync(join(served.bad, 'eden.mjs'), b);
  serving = served.v1;

  tokensFile = join(dir, 'gateway-tokens.txt');
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', tokensFile], /listening on (\S+)\n/);
  directory = `http://${m[1]}`;
  world = join(dir, 'w.sock');
  arrivals = join(dir, 'arrivals.txt');
  procs.push(spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', 'ab'.repeat(16), '--epoch', '1', '--arrivals', arrivals], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });

  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (redirect && url.pathname.endsWith('/v1/config')) { res.writeHead(302, { location: `${directory}/v1/config` }); return res.end(); }
    const a = answer(serving, url.pathname);
    if (a) { res.writeHead(a.status, { 'content-type': a.type }); return res.end(a.body); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fetch(new URL(req.url, directory), { method: req.method, headers: { 'content-type': 'application/json' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'text/plain' });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  site = `http://127.0.0.1:${server.address().port}/local`;
});

after(() => {
  for (const p of procs) p.kill();
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const folder = join(dir, 'empty'), home = join(folder, '.souls');
const env = { PATH: process.env.PATH, SOULS_HOME: home };
/** A program run to its end, without blocking this process (which serves the world's address). */
function ran(cmd, args, opts) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => ok({ status, stdout, stderr }));
  });
}
/** `node eden.mjs <args>` in the folder, as an agent runs it; its last line, parsed. */
async function eden(...args) {
  const r = await ran(process.execPath, ['eden.mjs', ...args], { cwd: folder, env });
  const last = r.stdout.trim().split('\n').at(-1);
  try { return JSON.parse(last); } catch { throw new Error(`eden.mjs ${args.join(" ")} (exit ${r.status}): ${r.stdout}${r.stderr}`); }
}
/** Every file under the home but the daemon's runtime, by its hash: what an upgrade may write. */
function snapshot() {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'runtime') walk(p); } else out[p.slice(home.length)] = sha(readFileSync(p)); } };
  walk(home);
  return out;
}
const daemonPid = (soul) => JSON.parse(readFileSync(runtimeOf(home, soul).lock, 'utf8')).pid;
const commandOf = (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
const arrived = () => { try { return readFileSync(arrivals, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };

let soul, rt, gw;

test('A1: the one line, in an empty folder, ends with a running client', async () => {
  mkdirSync(folder);
  // The one line: curl -fsSO <world>/eden.mjs && node eden.mjs pair <world>
  const got = await ran('curl', ['-fsSO', `${site}/eden.mjs`], { cwd: folder });
  assert.equal(got.status, 0, got.stderr);
  const gwPort = await freePort();
  const asked = await eden('pair', `${site}?gateway=ws://127.0.0.1:${gwPort}/v2/ws`);
  assert.equal(asked.step, 'approve', JSON.stringify(asked));
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).clientSite, site, 'the world\'s address is the home\'s one site');
  assert.deepEqual(readFileSync(join(home, 'bin/eden.mjs')), readFileSync(join(served.v1, 'eden.mjs')));

  const approve = await fetch(`${directory}/v1/pair/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'owner' }) });
  assert.equal(approve.status, 200);
  soul = await waitFor(() => { try { return Object.keys(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).souls)[0]; } catch { return null; } });
  ({ p: gw } = await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', world, '--tokens', tokensFile, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/));
  rt = runtimeOf(home, soul);

  const status = await eden('status');
  assert.equal(status.started, true, JSON.stringify(status));
  assert.match(commandOf(daemonPid(soul)), /bin\/client\/1\.0\.0-[0-9a-f]{16}\/v2\/client\/src\/daemon\/daemon\.mjs/, 'the daemon runs from the served client');
  assert.match(commandOf(daemonPid(soul)), /bin\/lib\/[0-9a-f]{16}/, 'with the library fetched by hash');
  await waitFor(async () => (await request(rt.socket, { op: 'status' })).connected);
  const act = await request(rt.socket, { op: 'act', verb: 'eden:wave' });
  assert.equal(act.ok, true, JSON.stringify(act));
  await waitFor(() => arrived().length === 1);
  console.log(`A1: ${JSON.stringify({ version: (await eden('version')).version, daemon: 'connected', arrivals: arrived().length })}`);
});

test('A3, A4: upgrade hands over with no intent sent twice; --rollback restores the first version', async () => {
  serving = served.v2;
  // An act the old daemon sends just before the hand-over, its answer possibly still on the way.
  assert.equal((await request(rt.socket, { op: 'act', verb: 'eden:wave' })).ok, true);
  const up = await eden('upgrade');
  assert.deepEqual(up.upgraded, { from: '1.0.0', to: '1.1.0' }, JSON.stringify(up));
  assert.equal(up.kept, '1.0.0');
  assert.deepEqual(up.handedOver, [{ soul, started: true, ok: true }]);
  assert.deepEqual(readFileSync(join(home, 'bin/eden.mjs')), readFileSync(join(served.v2, 'eden.mjs')));
  assert.deepEqual(readFileSync(join(home, 'bin/eden-1.0.0.mjs')), readFileSync(join(served.v1, 'eden.mjs')));
  assert.match(commandOf(daemonPid(soul)), /bin\/client\/1\.1\.0-/, 'the new daemon runs the new client');
  assert.equal((await eden('version')).version, '1.1.0', 'the folder copy hands off to the newer one');

  // A4: what the old daemon sent arrived once; the new one goes on from its sequence.
  await waitFor(async () => (await request(rt.socket, { op: 'status' })).connected);
  assert.equal((await request(rt.socket, { op: 'act', verb: 'eden:wave' })).ok, true);
  await waitFor(() => arrived().length >= 3);
  await sleep(500);
  const lines = arrived();
  assert.equal(lines.length, 3, `three acts, three arrivals: ${lines.join(' | ')}`);
  assert.equal(new Set(lines).size, 3, 'no intent arrived twice');
  assert.deepEqual((await request(rt.socket, { op: 'status' })).unanswered, [], 'nothing waits to be sent again');
  console.log(`A4: arrivals ${JSON.stringify(lines.map((l) => l.split(' ')[1]))}`);

  const back = await eden('upgrade', '--rollback');
  assert.deepEqual({ ok: back.ok, from: back.from, to: back.to }, { ok: true, from: '1.1.0', to: '1.0.0' }, JSON.stringify(back));
  assert.deepEqual(back.handedOver, [{ soul, started: true, ok: true }]);
  assert.deepEqual(readFileSync(join(home, 'bin/eden.mjs')), readFileSync(join(served.v1, 'eden.mjs')), 'the first version, byte for byte');
  assert.deepEqual(readFileSync(join(home, 'bin/skill.md')), readFileSync(join(served.v1, 'skill.md')));
  assert.equal(existsSync(join(home, 'bin/eden-1.0.0.mjs')), false);
  assert.match(commandOf(daemonPid(soul)), /bin\/client\/1\.0\.0-/);
  assert.equal((await eden('upgrade', '--rollback')).code, 'nothing-to-roll-back', 'one version kept back, rolled back once');
  await waitFor(async () => (await request(rt.socket, { op: 'status' })).connected);
  assert.equal(arrived().length, 3, 'a second hand-over sent nothing');
});

test('A3: a changed bundle, or a redirect, writes nothing', async () => {
  const before = snapshot();
  serving = served.bad;
  const bad = await eden('upgrade');
  assert.equal(bad.code, 'upgrade.mismatch', JSON.stringify(bad));
  assert.match(bad.detail, /eden\.mjs: its hash is not/);
  assert.deepEqual(snapshot(), before, 'not one file of the home changed');

  serving = served.v2;
  redirect = true;
  const moved = await eden('upgrade');
  redirect = false;
  assert.equal(moved.code, 'upgrade.redirect', JSON.stringify(moved));
  assert.deepEqual(snapshot(), before);
  console.log(`A3: changed bundle -> ${bad.code}; redirect -> ${moved.code}; home unchanged`);

  await request(rt.socket, { op: 'stop' }).catch(() => {});
  await waitFor(() => !existsSync(rt.lock));
  gw.kill();
});

test('0.133 Q2: the one line, in an empty folder below a Souls home, pairs into a home of its own; that home is not written to', async () => {
  const below = join(folder, 'projects', 'another');
  mkdirSync(below, { recursive: true });
  const before = snapshot();
  assert.equal((await ran('curl', ['-fsSO', `${site}/eden.mjs`], { cwd: below })).status, 0);
  const gwPort = await freePort();
  // no SOULS_HOME: the client finds the home above it, as on a person's machine
  const r = await ran(process.execPath, ['eden.mjs', 'pair', `${site}?gateway=ws://127.0.0.1:${gwPort}/v2/ws`], { cwd: below, env: { PATH: process.env.PATH, HOME: dir } });
  const asked = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(asked.step, 'approve', r.stdout + r.stderr);
  const approve = await fetch(`${directory}/v1/pair/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'owner' }) });
  assert.equal(approve.status, 200);
  await waitFor(() => existsSync(join(below, '.souls', 'credentials.json')));
  assert.ok(existsSync(join(below, '.souls', 'bin', 'eden.mjs')), 'the client installed in the new home');
  assert.deepEqual(snapshot(), before, 'the home above is byte-identical');
});
