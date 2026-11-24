// A Soul's public status line (Engine v2 C14, #3684; today's `now`): the agent sets it with `now "<line>"` (or
// `--now` on another command) through its daemon, the real gateway (`gatewayd --mailbox`) and the real directory
// (`directoryd`), and anyone reads it there by the Soul's grant (`POST /v1/account/now`), as the Soul's page and its
// owner's page do. Run from v2/ after `cargo build -p gatewayd -p worldd -p directoryd --locked`, with replica's
// wasm-bindgen package in target/wasm-load/pkg. C14_REPORT=1 prints the transcript, for the PR.

import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_PKG, call, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, '../cli/souls.mjs');
const SOUL = 's_c14test';
const GRANT = `soul-${'5c'.repeat(16)}-2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-c14-'));
const home = join(dir, '.souls');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const procs = [], logs = [], report = [];
let rt, directory;

function run(path, args, ready) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  const out = { text: '' };
  logs.push(out);
  return new Promise((ok, fail) => {
    p.stdout.on('data', (d) => { out.text += d; const m = ready?.exec(out.text); if (m) ok(m); });
    p.stderr.on('data', (d) => { out.text += d; });
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out.text}`)));
    if (!ready) ok(null);
  });
}

async function waitFor(f, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

const ask = (req, ms = 5000) => request(rt.socket, req, ms);
/** The Soul's agent: one command of the thin CLI, its JSON answer. */
async function soulSays(...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } });
  const out = JSON.parse(stdout);
  report.push({ command: args.map((a) => (a.length > 60 ? `${a.slice(0, 20)}…(${a.length})` : a)).join(' '), answer: out });
  return out;
}
/** What anyone reads: the public lines of these grants. */
async function read(...souls) {
  const r = await fetch(`http://${directory}/v1/account/now`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ souls }) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt'), key = join(dir, 'mailbox.key');
  writeFileSync(tokens, `${GRANT} ${createHash('sha256').update(token).digest('hex')}\n`);
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  mkdirSync(join(dir, 'world', 'receipts'), { recursive: true });
  run(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--arrivals', join(dir, 'world', 'arrivals.txt'), '--roots', join(dir, 'world', 'roots.txt'), '--rooms', '1', '--bodies', '4']).catch(() => {});
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  [, directory] = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.db'), '--test-sign-in', '--mailbox-key', key], /listening on (\S+)\n/);
  const [, gw] = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'world', 'receipts'), '--mailbox', directory, '--mailbox-key', key], /listening (\S+)\n/);
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gw}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await call(home, SOUL, { op: 'status' }, { pkg: PKG });
  await waitFor(async () => (await ask({ op: 'status' })).connected, 10_000);
});

after(async () => {
  await ask({ op: 'stop' }).catch(() => {});
  if (process.env.C14_REPORT) console.log(JSON.stringify(report, null, 1));
  await stopThenRemove(procs, dir);
});

const LINE = `Mending nets by the pier ${randomBytes(4).toString('hex')}`;

test('A1: now "<line>" sets the public line, anyone reads it by grant, status shows it, and an empty now clears it', async () => {
  const set = await soulSays('now', LINE);
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.now.text, LINE);
  assert.ok(Math.abs(set.now.at - Date.now() / 1000) < 60, 'set at, seconds');
  const got = await read(GRANT, `soul-${'5c'.repeat(16)}-9`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, { now: { [GRANT]: set.now } }, 'only the line and its time, only for a Soul that has one');
  assert.deepEqual((await soulSays('status')).now, set.now);
  // Cleaned as today: one line, no control or bidi characters.
  assert.equal((await soulSays('now', 'Rowing\nout‮  again ')).now.text, 'Rowing out again');
  const cleared = await soulSays('now');
  assert.deepEqual([cleared.ok, cleared.now], [true, null]);
  assert.deepEqual((await read(GRANT)).body, { now: {} });
  assert.equal((await soulSays('now', 'back')).now.text, 'back');
  assert.deepEqual((await soulSays('now', '--clear')).now, null);
});

test('A1: a line over 140 characters is refused by name and the line kept; --now rides on another command', async () => {
  await soulSays('now', LINE);
  const long = await soulSays('now', 'é'.repeat(141));
  assert.deepEqual([long.ok, long.code], [false, 'now.too-long']);
  assert.match(long.detail, /at most 140 characters, not 141/);
  assert.equal((await read(GRANT)).body.now[GRANT].text, LINE);
  assert.equal((await soulSays('now', 'é'.repeat(140))).ok, true, '140 characters is a line');
  const said = await soulSays('say', 'good morning', '--now', 'Saying good morning');
  assert.equal(said.ok, true, JSON.stringify(said));
  assert.equal(said.now.now.text, 'Saying good morning');
  assert.equal((await read(GRANT)).body.now[GRANT].text, 'Saying good morning');
});

test('A3: an owner\'s open message is never the public line; nothing of the line reaches the world', async () => {
  const words = `please buy bread at the bakery ${randomBytes(3).toString('hex')}`;
  const put = await fetch(`http://${directory}/v1/mailbox/put`, { method: 'POST', body: JSON.stringify({ soul: GRANT, text: words }) });
  assert.equal(put.status, 200);
  await waitFor(async () => (await ask({ op: 'wait', seconds: 0 }, 6000)).events?.some((e) => e.kind === 'mail'), 8000);
  const leak = await soulSays('now', `Owner says: ${words.toUpperCase()}`);
  assert.deepEqual([leak.ok, leak.code], [false, 'now.owner-words']);
  assert.equal((await read(GRANT)).body.now[GRANT].text, 'Saying good morning', 'the line kept');
  // The world's files hold no line: it is the directory's, never the world's.
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(join(dir, 'world'));
  for (const f of files) for (const w of [LINE, 'Saying good morning']) assert.ok(!readFileSync(f, 'utf8').includes(w), `${f} holds the line`);
  // Logged by kind, never by text.
  const all = logs.map((l) => l.text).join('\n');
  assert.match(all, /\/v1\/mailbox\/now 200 now set/);
  assert.ok(!all.includes(LINE), 'a log holds the line');
});
