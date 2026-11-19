// Pairing a Soul to an agent (Engine v2 W2, #2705), end to end: the real directory (`directoryd` with the sign-in
// for test worlds), the real gateway (`gatewayd`, I1) and the world's stand-in end of it (`worldd gateway-link`), and
// the daemon (R6). Run from v2/ after
//   cargo build -p directoryd -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// A3, A4 and A5's server side are directoryd's unit tests (`cargo test -p directoryd pairing`).

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { pair } from './pair.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-w2-'));
const procs = [];
const outputs = []; // every line any program printed and every reply the browser's requests got

function run(path, args, ready, opts = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; outputs.push(String(d)); const m = ready?.exec(out); if (m) ok({ p, m }); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => (ready ? fail(new Error(`${path} ended (${c}): ${out}`)) : ok({ p, out, code: c })));
  });
}

async function waitFor(f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

let directory, world, arrivals, tokensFile;

before(async () => {
  tokensFile = join(dir, 'gateway-tokens.txt');
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', tokensFile], /listening on (\S+)\n/);
  directory = `http://${m[1]}`;
  world = join(dir, 'w.sock');
  arrivals = join(dir, 'arrivals.txt');
  procs.push(spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', 'ab'.repeat(16), '--epoch', '1', '--arrivals', arrivals], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
});

after(() => {
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** What the card does in the browser: a POST, signed in as W1's test person. Its reply is kept for A2. */
async function browser(path, body, method = 'POST') {
  const r = await fetch(new URL(path, directory), method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  outputs.push(text);
  return { status: r.status, text, body: r.headers.get('content-type').startsWith('application/json') ? JSON.parse(text) : null };
}

test('A1, A2, A3: from an empty folder the owner approves once, the daemon acts, and the token is nowhere else', async () => {
  const folder = join(dir, 'empty');
  mkdirSync(folder);
  assert.deepEqual(readdirSync(folder), []);
  const home = join(folder, '.souls');
  const gwPort = await freePort();
  const gateway = `ws://127.0.0.1:${gwPort}/v2/ws`;

  // The daemon asks: a link and a code, and it polls.
  const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', directory, '--world', 'local',
    '--gateway', gateway, '--device', 'test machine', '--label', 'test agent'],
  null, { cwd: folder, env: { PATH: process.env.PATH, SOULS_HOME: home } });
  const asked = await waitFor(() => outputs.map((o) => o.split('\n')).flat().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve'));
  assert.match(asked.code, /^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
  assert.equal(asked.link, `http://127.0.0.1:1/pair?code=${asked.code}`);

  // A3: opening the link approves nothing; neither does a POST that is not signed in, or one not confirmed.
  const card = await browser(`/pair?code=${asked.code}`, null, 'GET');
  assert.equal(card.status, 200);
  assert.match(card.text, /A device is asking to act as your Soul/);
  assert.equal((await browser(`/v1/pair/approve?code=${asked.code}`, null, 'GET')).status, 405);
  assert.equal((await browser('/v1/pair/approve', { code: asked.code, confirm: true })).body.refused, 'signed-out');
  assert.equal((await browser('/v1/pair/approve', { code: asked.code, test_person: 'owner' })).body.refused, 'confirm');
  const shown = await browser('/v1/pair/show', { code: asked.code, test_person: 'owner' });
  assert.equal(shown.status, 200);
  assert.deepEqual({ ...shown.body, age: typeof shown.body.age },
    { device: 'test machine', label: 'test agent', soul: null, code: asked.code, age: 'number', scope: 'soul', force: false, connected: null });
  await sleep(200);
  assert.equal(readdirSync(folder).includes('.souls'), false, 'nothing paired before the approval');

  // The owner approves once; the daemon's next poll (5 s) gets the token.
  const approved = await browser('/v1/pair/approve', { code: asked.code, confirm: true, test_person: 'owner' });
  assert.equal(approved.status, 200);
  const done = await asking;
  assert.equal(done.code, 0, done.out);
  const said = JSON.parse(done.out.trim().split('\n').at(-1));
  assert.equal(said.ok, true);
  assert.equal(said.grant, approved.body.soul);

  // The gateway checks the token by the hash the directory wrote, and an act sent with it is accepted.
  const { p: gw } = await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', world, '--tokens', tokensFile, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const rt = runtimeOf(home, said.soul);
  try {
    const act = await call(home, said.soul, { op: 'act', verb: 'eden:wave' }, { pkg: PKG });
    outputs.push(JSON.stringify(act));
    assert.equal(act.ok, true);
    await waitFor(() => { try { return readFileSync(arrivals, 'utf8').trim().split('\n').length >= 1; } catch { return false; } });
    const st = await waitFor(async () => { const s = await request(rt.socket, { op: 'status' }); return s.connected && s.unanswered.length === 0 && s; });
    outputs.push(JSON.stringify(st));
    assert.equal(st.answered, 1, 'the act was accepted and answered');
  } finally {
    await request(rt.socket, { op: 'stop' }).catch(() => {});
    gw.kill();
    await waitFor(() => !existsSync(rt.lock));
  }

  // A2: the token is in credentials.json (0600) and in no output, log, browser reply or store; the store and the
  // gateway's tokens file hold its hash.
  const token = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).souls[said.soul].local.token;
  const secret = token.split('.')[1];
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  for (const o of outputs) assert.ok(!String(o).includes(secret), 'not in any output or reply');
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(dir);
  const others = files.filter((f) => !f.endsWith('credentials.json'));
  assert.ok(others.some((f) => f.endsWith('daemon.log')) && others.some((f) => f.endsWith('pairing.sqlite')));
  for (const f of others) assert.ok(!readFileSync(f, 'latin1').includes(secret), `not in ${f.slice(dir.length)}`);
  const hash = createHash('sha256').update(token).digest('hex');
  assert.ok(readFileSync(tokensFile, 'utf8').includes(`${said.grant} ${hash}`), 'the gateway holds its hash');
  const db = files.filter((f) => f.includes('pairing.sqlite')).map((f) => readFileSync(f, 'latin1')).join('');
  assert.ok(db.includes(hash), 'the store holds its hash');
});

test('a directory that is not https is refused, unless it is on this machine', async () => {
  const args = { home: join(dir, 'never', '.souls'), world: 'w', gateway: 'ws://x', device: 'd', label: 'l' };
  await assert.rejects(pair({ ...args, directory: 'http://directory.example.test' }), { code: 'directory-not-https' });
  await assert.rejects(pair({ ...args, directory: 'ftp://127.0.0.1' }), { code: 'directory-not-https' });
});

test('A5: the daemon polls every interval and adds 5 s on "slow_down"', async () => {
  const answers = ['authorization_pending', 'slow_down', 'authorization_pending', 'slow_down', 'approved'];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/pair/request') return res.end(JSON.stringify({ code: 'BCDF-GHJK', link: 'x', interval: 5 }));
      const a = answers.shift();
      res.end(JSON.stringify(a === 'approved' ? { token: `soul-${'ab'.repeat(16)}-0.${'cd'.repeat(32)}`, grant: `soul-${'ab'.repeat(16)}-0` } : { pending: a }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const waits = [];
  try {
    const home = join(dir, 'a5', '.souls');
    const out = await pair({ home, directory: `http://127.0.0.1:${server.address().port}`, world: 'w', gateway: 'ws://x', device: 'd', label: 'l',
      unit: 1, sleep: async (ms) => { waits.push(ms); } });
    assert.equal(out.soul, `s_${'ab'.repeat(16)}-0`);
  } finally { server.close(); }
  assert.deepEqual(waits, [5, 5, 10, 10, 15]);
});
