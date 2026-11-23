// D2 (0.132 Core): `listen --follow` prints each owner message as it arrives, and `here` is a name for `look`, against
// the real directory (`directoryd`, its mailbox), the real gateway (`gatewayd --mailbox`) and the world's end of it
// (`worldd gateway-link`), as R20's pending.test.mjs runs them. Run from v2/ after
//   cargo build -p gatewayd -p worldd -p directoryd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { listen, requestOf, wakeOf } from './souls.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const CLI = join(v2, 'client/src/cli/souls.mjs');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_d2test';
const GRANT = `soul-${'2b'.repeat(16)}-2`;
const LAMP = `${'2b'.repeat(16)}-3`; // the Soul's own lamp (wake/pending.test.mjs)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-d2-'));
const home = join(dir, '.souls');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const env = { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG };
const procs = [];
let directory, rt;

function run(path, args, ready) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = ready.exec(out); if (m) ok(m); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out}`)));
  });
}

async function waitFor(f, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

const mailbox = (path, body) => fetch(`http://${directory}/v1/mailbox/${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const ask = (req, ms = 5000) => request(rt.socket, req, ms);
const souls = (...args) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: 'utf8' }).stdout.trim().split('\n').at(-1));

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt'), key = join(dir, 'mailbox.key');
  writeFileSync(tokens, `${GRANT} ${createHash('sha256').update(token).digest('hex')}\n`);
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  const wl = spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', '4'], { stdio: 'ignore' });
  procs.push(wl);
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  [, directory] = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.db'), '--test-sign-in', '--mailbox-key', key], /listening on (\S+)\n/);
  const [, gateway] = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--mailbox', directory, '--mailbox-key', key], /listening (\S+)\n/);
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gateway}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await call(home, SOUL, { op: 'status' }, { pkg: PKG });
  await waitFor(async () => (await ask({ op: 'status' })).connected);
});

after(async () => {
  await ask({ op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('the arguments: here is look; listen takes --follow', () => {
  assert.deepEqual(requestOf(['here']).req, { op: 'look' });
  assert.deepEqual(requestOf(['listen']).req, { op: 'listen' });
  assert.deepEqual(requestOf(['listen', '--follow']).req, { op: 'listen', follow: true });
});

test('here answers as look does', () => {
  const [here, look] = [souls('here'), souls('look')];
  assert.equal(here.ok, true, JSON.stringify(here));
  assert.deepEqual(Object.keys(here).filter((k) => k !== 'news').sort(), Object.keys(look).filter((k) => k !== 'news').sort());
});

test('listen --follow prints each owner message as it arrives, once, and takes nothing from wait', async () => {
  await ask({ op: 'wait', seconds: 0 }); // what happened at sign-in, taken
  const open = await mailbox('put', { soul: GRANT, text: 'already waiting' });
  await waitFor(async () => (await ask({ op: 'pending', list: true })).open?.some((m) => m.id === open.id));
  const p = spawn(process.execPath, [CLI, 'listen', '--follow'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  const lines = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; const k = buf.lastIndexOf('\n'); if (k >= 0) { lines.push(...buf.slice(0, k).split('\n').map((l) => JSON.parse(l))); buf = buf.slice(k + 1); } });
  await waitFor(() => lines.length === 1);
  assert.deepEqual([lines[0].kind, lines[0].id, lines[0].text], ['mail', open.id, 'already waiting'], 'a message open when it starts');
  assert.match(lines[0].serve, new RegExp(`--for ${open.id}`));
  const ids = [];
  for (const text of ['walk to the library', 'and sit']) {
    const t0 = Date.now();
    ids.push((await mailbox('put', { soul: GRANT, text })).id);
    await waitFor(() => lines.length === ids.length + 1);
    assert.ok(Date.now() - t0 < 5000, `printed within seconds of arriving: ${Date.now() - t0} ms`);
  }
  assert.deepEqual(lines.slice(1).map((l) => [l.id, l.text]), [[ids[0], 'walk to the library'], [ids[1], 'and sit']]);
  await sleep(1500);
  assert.equal(lines.length, 3, 'each printed once');
  assert.equal(p.exitCode, null, 'still following');
  const read = await ask({ op: 'wait', seconds: 0 });
  assert.deepEqual(read.events.filter((e) => e.kind === 'mail').map((e) => e.id), ids, 'wait still has them (pending read the first)');
  p.kill();
  const once = spawnSync(process.execPath, [CLI, 'listen'], { cwd: dir, env, encoding: 'utf8' });
  assert.deepEqual(once.stdout.trim().split('\n').map((l) => JSON.parse(l).id), [open.id, ...ids], 'listen alone prints what is open and returns');
});

test('listen --follow keeps going across a daemon restart and misses nothing', async () => {
  const printed = [];
  let t = 0;
  const answers = [
    { ok: true, cursor: 4, daemon: 1, mail: [{ id: 'm1', text: 'a' }] },
    { ok: false, code: 'daemon-unreachable' },
    { ok: true, cursor: 2, daemon: 2, mail: [{ id: 'm1', text: 'a' }, { id: 'm2', text: 'b' }] },
    { ok: true, cursor: 3, daemon: 2, mail: [{ id: 'm3', text: 'c' }] },
  ];
  const asked = [];
  await listen(async (r) => { asked.push(r.since); if (++t > answers.length) throw Object.assign(new Error('done'), { code: 'end' }); return answers[t - 1]; },
    (v) => { if (v.code === 'end') throw v; printed.push(v.id); }, { follow: true, pause: async () => { if (t > answers.length) throw new Error('end'); } }).catch(() => {});
  assert.deepEqual(printed, ['m1', 'm2', 'm3']);
  assert.deepEqual(asked.slice(0, 4), [undefined, 4, undefined, 2], 'after a failure, from the open messages again');
});

/** A `listen --follow` started now: its JSON lines as they come, and a stop. */
function follow() {
  const p = spawn(process.execPath, [CLI, 'listen', '--follow'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  const lines = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; const k = buf.lastIndexOf('\n'); if (k >= 0) { lines.push(...buf.slice(0, k).split('\n').map((l) => JSON.parse(l))); buf = buf.slice(k + 1); } });
  return { lines, stop: () => p.kill() };
}

test('R5: wake takes named rules: act-ended, soul-arrives [who], idle <minutes>, a rule as JSON, remove and budget', () => {
  assert.deepEqual(wakeOf([]), { op: 'wake', do: 'list' });
  assert.deepEqual(wakeOf(['add', 'act-ended']).rule.when, { event: 'client:act-ended' });
  assert.deepEqual(wakeOf(['add', 'soul-arrives']).rule.when, { event: 'souls:move-ended' });
  assert.deepEqual(wakeOf(['add', 'soul-arrives', 's_ab']).rule.when, { event: 'souls:move-ended', from: ['s_ab'] });
  assert.deepEqual(wakeOf(['add', 'idle', '5']).rule.when, { event: 'client:idle', fields: { 1: 300 } }, 'the quiet in seconds');
  assert.equal(wakeOf(['add', 'idle', 'soon']).refused, 'wake-idle-minutes');
  assert.equal(wakeOf(['add', 'soul-arrives', 'Ada']).refused, 'wake-soul');
  assert.equal(wakeOf(['add', 'place-busy']).refused, 'wake-usage');
  assert.deepEqual(wakeOf(['remove', 'w2']), { op: 'wake', do: 'remove', id: 'w2' });
  assert.deepEqual(wakeOf(['budget', 'lively', '--day', '20']), { op: 'wake', do: 'budget', hour: 'lively', day: 20 });
  assert.deepEqual(requestOf(['wake', 'add', 'act-ended']).req, wakeOf(['add', 'act-ended']), 'reached from the served command');
});

test('R5: an act of my own ending, a quiet spell, and a Soul arriving each wake listen --follow; a removed rule does not', async () => {
  const added = (w) => souls('wake', ...w).added;
  const acts = added(['add', 'act-ended']);
  const quiet = added(['add', '{"when":{"event":"client:idle","fields":{"1":2}},"why":"quiet for 2 s"}']);
  const arrives = added(['add', 'soul-arrives']);
  assert.ok(acts && quiet && arrives, 'three rules added');
  assert.deepEqual(souls('wake').rules.map((r) => r.id), [acts, quiet, arrives], 'and listed');
  souls('wake', 'budget', 'unlimited');
  const f = follow();
  // A quiet spell: no command for 2 s.
  await waitFor(() => f.lines.find((l) => l.kind === 'wake' && l.rule === quiet), 15_000).catch((e) => { throw new Error(`no idle wake: ${JSON.stringify(souls('wake'))} ${JSON.stringify(f.lines.filter((l) => l.kind !== 'mail'))}`, { cause: e }); });
  // My own act ends (a lamp switched on): its receipt wakes the reader.
  const acted = souls('act', `r2:switch_on:${LAMP}`, '--wait');
  assert.equal(acted.ok, true, JSON.stringify(acted));
  await waitFor(() => f.lines.find((l) => l.kind === 'wake' && l.rule === acts), 15_000).catch((e) => { throw new Error(`no act-ended wake: ${JSON.stringify(f.lines)}`, { cause: e }); });
  // Another Soul's move ending near me, as the world's \`souls:move-ended\` reaches the daemon (injected here: the
  // world sends this Soul no other body's entries today).
  await ask({ op: 'event', event: { name: 'souls:move-ended', fields: {}, actor: 's_other', toMe: false } });
  const arrived = await waitFor(() => f.lines.find((l) => l.kind === 'wake' && l.rule === arrives), 15_000);
  assert.equal(arrived.untrusted, true, 'another Soul caused it');
  // Removed, a rule wakes no more.
  assert.equal(souls('wake', 'remove', arrives).removed, arrives);
  assert.deepEqual(souls('wake').rules.map((r) => r.id), [acts, quiet]);
  const before = f.lines.filter((l) => l.rule === arrives).length;
  await ask({ op: 'event', event: { name: 'souls:move-ended', fields: {}, actor: 's_other', toMe: false } });
  await sleep(1500);
  assert.equal(f.lines.filter((l) => l.rule === arrives).length, before, 'no wake from a removed rule');
  f.stop();
});
