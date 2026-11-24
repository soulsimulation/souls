// The owner's messages to a world's creator, through souls-god.mjs's listen, pending and ack, against the real
// directory (`directoryd`, its mailbox), the real gateway (`gatewayd --mailbox`) and the world (`worldd gateway-link
// --creator`). Run from v2/ after `cargo build -p gatewayd -p worldd -p directoryd --locked`, with replica's
// wasm-bindgen package in target/wasm-load/pkg.

import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG } from '../daemon/client.mjs';
import { requestOf } from './souls-god.mjs';
import { stopThenRemove } from '../../../tools/teardown/stop.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const GOD = join(here, 'souls-god.mjs');
const KINDS = `{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-god-mail-'));
const home = join(dir, '.souls');
const scope = randomBytes(16).toString('hex');
const grant = `creator-${scope}-1`;
const token = `${grant}.${randomBytes(32).toString('hex')}`;
const procs = [];
let directory;

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
  for (const until = Date.now() + ms; ;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(50);
  }
}

/** One run of the creator's command: every line it printed, as JSON. */
const godLines = (...args) => new Promise((ok) => {
  execFile(process.execPath, [GOD, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } }, (_, stdout) => {
    ok(stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  });
});
const god = async (...args) => (await godLines(...args)).at(-1);
const mailbox = (path, body) => fetch(`http://${directory}/v1/mailbox/${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt'), key = join(dir, 'mailbox.key');
  writeFileSync(tokens, `${grant} ${createHash('sha256').update(token).digest('hex')}\n`);
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  mkdirSync(join(dir, 'receipts'));
  procs.push(spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--rooms', '1', '--bodies', '1', '--creator', `${scope}-1`, '--no-measures'], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  [, directory] = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.db'), '--test-sign-in', '--mailbox-key', key], /listening on (\S+)\n/);
  const [, gateway] = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'receipts'), '--mailbox', directory, '--mailbox-key', key], /listening (\S+)\n/);
  mkdirSync(join(home, 'kinds'), { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gateway}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [`c_${scope}-1`]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  writeFileSync(join(home, 'kinds', 'local.kinds'), KINDS);
  await waitFor(async () => (await god('status')).connected);
});

after(async () => {
  await god('stop').catch(() => {});
  await stopThenRemove(procs, dir);
});

test('listen, pending and ack make the daemon\'s requests, and a wrong form names its usage', () => {
  assert.deepEqual(requestOf(['pending']).req, { op: 'pending', list: true });
  assert.deepEqual(requestOf(['ack', 'm1', 'on', 'it']).req, { op: 'ack', id: 'm1', reply: 'on it' });
  assert.deepEqual(requestOf(['ack', 'm1', 'no', '--close', 'failed']).req, { op: 'ack', id: 'm1', reply: 'no', close: 'failed' });
  assert.deepEqual(requestOf(['listen', '--follow']).listen, { seconds: 30, follow: true });
  assert.deepEqual(requestOf(['listen', '5']).listen, { seconds: 5, follow: false });
  assert.throws(() => requestOf(['ack', 'm1']), /ack <message id>/);
  assert.throws(() => requestOf(['ack', 'm1', 'x', '--close', 'maybe']), /done\|failed/);
  assert.throws(() => requestOf(['listen', 'soon']), /listen \[<seconds>\]/);
});

test('the owner\'s message reaches the creator by listen and pending, and ack answers and closes it', async () => {
  const quiet = await god('listen', '0');
  assert.equal(quiet.ok, true, JSON.stringify(quiet));
  assert.equal(quiet.timedOut, true);

  const { id } = await mailbox('put', { soul: grant, text: 'add a lamp to the hall' });
  assert.ok(id);
  const heard = await god('listen', '10');
  const mail = heard.events?.find((e) => e.kind === 'mail');
  assert.equal(mail?.id, id, JSON.stringify(heard));
  assert.equal(mail.text, 'add a lamp to the hall');

  const open = await god('pending');
  assert.equal(open.ok, true, JSON.stringify(open));
  assert.deepEqual(open.open.map((m) => m.id), [id]);

  const note = await god('ack', id, 'looking for a spot');
  assert.equal(note.ok, true, JSON.stringify(note));
  assert.equal(note.open, true);
  assert.equal((await mailbox('read', { id })).state, 'open', 'an interim note leaves it open');

  const done = await god('ack', id, 'done, by the door', '--close', 'done');
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.closed, 'done');
  const closed = await waitFor(async () => { const r = await mailbox('read', { id }); return r.state !== 'open' && r; });
  assert.equal(closed.state, 'done', JSON.stringify(closed));
  assert.deepEqual((await god('pending')).open, []);

  const unknown = await god('ack', 'm_nope', 'hi', '--close', 'done');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'mail-not-found');
});

test('listen --follow prints a line when a message arrives and none while it waits', async () => {
  const p = spawn(process.execPath, [GOD, 'listen', '1', '--follow'], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  try {
    await sleep(2500);
    assert.equal(out, '', 'a wait that timed out prints nothing');
    const { id } = await mailbox('put', { soul: grant, text: 'and a bench' });
    const line = await waitFor(() => out.split('\n').find((l) => l.includes(id)));
    assert.equal(JSON.parse(line).events.find((e) => e.kind === 'mail').text, 'and a bench');
  } finally { p.kill(); }
});
