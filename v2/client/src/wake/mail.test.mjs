// Wakes and the owner's messages through the Soul's daemon (Engine v2 R13, #2753), against the real directory
// (`directoryd`, its mailbox), the real gateway (`gatewayd --mailbox`) and the world's end of it (`worldd
// gateway-link`). Run from v2/ after `cargo build -p gatewayd -p worldd -p directoryd --locked`, with replica's
// wasm-bindgen package in target/wasm-load/pkg. R13_REPORT=1 prints the delays, for the PR.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, call, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { BRIEF_MOST } from '../brief/brief.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const SOUL = 's_r13test';
const WORLD_SCOPE = '2b'.repeat(16);
const LAMP = `${WORLD_SCOPE}-3`; // the Soul's own lamp (daemon.test.mjs says why)
const GRANT = `soul-${WORLD_SCOPE}-2`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-r13-'));
const home = join(dir, '.souls');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const procs = [];
const report = {};
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

async function waitFor(f, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
}

/** The directory's test call: what W10's box will do. */
const mailbox = (path, body) => fetch(`http://${directory}/v1/mailbox/${path}`, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
const ask = (req, ms = 5000) => request(rt.socket, req, ms);

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt'), key = join(dir, 'mailbox.key');
  writeFileSync(tokens, `${GRANT} ${createHash('sha256').update(token).digest('hex')}\n`);
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  mkdirSync(join(dir, 'world', 'receipts'), { recursive: true });
  const wl = spawn(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--arrivals', join(dir, 'world', 'arrivals.txt'), '--roots', join(dir, 'world', 'roots.txt'), '--rooms', '1', '--bodies', '4'], { stdio: 'ignore' });
  procs.push(wl);
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  [, directory] = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.db'), '--test-sign-in', '--mailbox-key', key], /listening on (\S+)\n/);
  const [, gateway] = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'world', 'receipts'), '--mailbox', directory, '--mailbox-key', key], /listening (\S+)\n/);
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${gateway}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await call(home, SOUL, { op: 'status' }, { pkg: PKG });
  await waitFor(async () => (await ask({ op: 'status' })).connected, 10_000);
});

after(async () => {
  await ask({ op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  if (process.env.R13_REPORT) console.log(JSON.stringify(report));
  rmSync(dir, { recursive: true, force: true });
});

test('A1 (the daemon\'s half): a rule fires and the open reader returns its wake within 5 s', async () => {
  await ask({ op: 'wait', seconds: 0 }); // what happened at sign-in, taken
  const added = await ask({ op: 'wake', do: 'add', rule: { when: { event: 'eden:say', toMe: true }, why: 'someone spoke to you' } });
  assert.equal(added.added, 'w1');
  const ms = [];
  for (let k = 0; k < 5; k++) {
    const reader = ask({ op: 'wait', seconds: 30 }, 35_000);
    await sleep(200);
    const t0 = performance.now();
    assert.equal((await ask({ op: 'event', event: { name: 'eden:say', actor: 's_ada', toMe: true, fields: { 1: 'hi' } } })).fired, true);
    const got = await reader;
    ms.push(Math.round(performance.now() - t0));
    assert.equal(got.wakes.length, 1);
    assert.equal(got.wakes[0].why, 'someone spoke to you');
    assert.equal(got.wakes[0].untrusted, true, 'another Soul caused it');
    await ask({ op: 'look' }); // the model's turn confirms it
  }
  report.wakeMs = ms;
  for (const t of ms) assert.ok(t < 5000, `${t} ms`);
});

test('A2, A3 (the daemon\'s half): over the budget, and with no reader, wakes merge and wait', async () => {
  await ask({ op: 'wake', do: 'budget', hour: 6 }); // five delivered above: one left this hour
  for (let k = 0; k < 4; k++) await ask({ op: 'event', event: { name: 'eden:say', actor: 's_bo', toMe: true } });
  const queued = (await ask({ op: 'wake' })).queued;
  assert.deepEqual(queued.map((q) => [q.rule, q.count]), [['w1', 4]], 'no reader: one entry, merged');
  const first = await ask({ op: 'wait', seconds: 1 }, 6000);
  assert.equal(first.wakes[0].count, 4, 'handed as one delivery');
  await ask({ op: 'event', event: { name: 'eden:say', actor: 's_bo', toMe: true } });
  const second = await ask({ op: 'wait', seconds: 1 }, 6000);
  assert.equal(second.wakes, undefined, 'the budget is spent: it waits');
  assert.equal(second.timedOut, true);
  const v = await ask({ op: 'wake' });
  assert.equal(v.budget.deliveredLastHour, 6);
  assert.equal(v.queued[0].count, 1);
  // Kept on disk: a restarted daemon is held to the same count.
  assert.equal(JSON.parse(readFileSync(rt.state, 'utf8')).wake.delivered.length, 6);
});

test('A4, A5: a mailbox message reaches the agent, its act closes it with the outcome, and its words reach no world file', async () => {
  const words = `fetch the lamp ${randomBytes(6).toString('hex')}`;
  const reader = ask({ op: 'wait', seconds: 30 }, 35_000);
  await sleep(200);
  const t0 = performance.now();
  const { id } = await mailbox('put', { soul: GRANT, text: words });
  assert.match(id, /^m_[0-9a-f]{16}$/);
  const got = await reader;
  report.mailMs = Math.round(performance.now() - t0);
  const m = got.events.find((e) => e.kind === 'mail');
  assert.equal(m.id, id);
  assert.equal(m.text, words);
  assert.ok(report.mailMs < 5000, `${report.mailMs} ms`);
  // An act for it: its outcome closes it.
  assert.equal((await ask({ op: 'act', verb: 'r2:switch_on', target: LAMP, for: 'm_0000000000000000' })).code, 'mail-not-found');
  const act = await ask({ op: 'act', verb: 'r2:switch_on', target: LAMP, for: id });
  assert.equal(act.ok, true);
  const closed = await waitFor(async () => { const r = await mailbox('read', { id }); return r.state !== 'open' && r; });
  report.closed = { state: closed.state, outcome: closed.outcome };
  assert.equal(closed.state, 'done');
  // Q1: an errand's later step on the message its first step's end closed goes unlinked and says so; a later reply is
  // refused `mail-closed`, and the close stands.
  const later = await ask({ op: 'act', verb: 'r2:switch_on', target: LAMP, for: id });
  assert.deepEqual([later.ok, later.unlinked?.for, later.unlinked?.closed], [true, id, 'done'], JSON.stringify(later));
  // the agent is told its owner will not see the reply (the mailbox takes no word on a closed message)
  const reply = await ask({ op: 'ack', id, reply: 'it is on', close: 'done' });
  assert.deepEqual([reply.ok, reply.code, reply.shown, reply.sent, reply.closed], [false, 'mail-closed', false, false, 'done'], JSON.stringify(reply));
  assert.match(reply.detail, /will not see/);
  await sleep(1200); // past a mailbox read
  assert.equal((await mailbox('read', { id })).state, 'done', 'still closed done, once');
  // Once only: a second message's act that is refused closes that one `failed`.
  const two = await mailbox('put', { soul: GRANT, text: 'again' });
  await waitFor(async () => (await ask({ op: 'wait', seconds: 1 }, 6000)).events.some((e) => e.kind === 'mail' && e.id === two.id));
  await ask({ op: 'act', verb: 'r2:switch_on', target: LAMP, for: two.id }); // on already: refused
  const failed = await waitFor(async () => { const r = await mailbox('read', { id: two.id }); return r.state !== 'open' && r; });
  report.refusedClosed = { state: failed.state, outcome: failed.outcome };
  assert.equal(failed.state, 'failed');
  // A5: the world's files (what it took, its changes, the receipts) hold neither message's words.
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(join(dir, 'world'));
  assert.ok(files.length >= 2, files.join(' '));
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!text.includes(words) && !text.includes('again'), `${f} holds a message's words`);
  }
  assert.ok(readFileSync(join(dir, 'world', 'arrivals.txt'), 'utf8').trim().split('\n').length >= 2, 'the acts reached the world');
});

test('C15 (#3685): pending lists what is open and what arrived; ack answers with no act, done or failed', async () => {
  await ask({ op: 'wait', seconds: 0 }); // what came before, taken
  const read = (id) => waitFor(async () => { const r = await mailbox('read', { id }); return r.state !== 'open' && r; });
  const listedWith = (id) => waitFor(async () => { const p = await ask({ op: 'pending', list: true }); return p.open.some((m) => m.id === id) && p; });
  // A3: the listing holds the message still open, and what arrived since the last read, once.
  const q = await mailbox('put', { soul: GRANT, text: 'what time is it?' });
  const first = await listedWith(q.id);
  assert.equal(first.ok, true);
  assert.deepEqual(first.open.find((m) => m.id === q.id).text, 'what time is it?');
  assert.ok(first.events.some((e) => e.kind === 'mail' && e.id === q.id), 'the arrival is listed');
  assert.match(first.next, /ack <its id>/);
  const second = await ask({ op: 'pending', list: true });
  assert.ok(second.open.some((m) => m.id === q.id), 'still open: listed again');
  assert.ok(!second.events.some((e) => e.kind === 'mail'), 'the arrival was read: not again');
  // #3781: with no --close, a reply is an interim note: the message stays open, in the directory and the listing.
  const note = await ask({ op: 'ack', id: q.id, reply: 'one moment' });
  assert.deepEqual([note.ok, note.open, note.closed], [true, true, undefined], JSON.stringify(note));
  await sleep(1200); // past a mailbox read
  assert.equal((await mailbox('read', { id: q.id })).state, 'open', 'a note leaves it open');
  assert.ok((await ask({ op: 'pending', list: true })).open.some((m) => m.id === q.id), 'still listed');
  // A1: a reply-only ack with --close done answers it with no act, and closes it done.
  assert.equal((await ask({ op: 'ack', id: 'm_0000000000000000', reply: 'hi' })).code, 'mail-not-found');
  assert.equal((await ask({ op: 'ack', id: q.id, reply: '   ' })).code, 'ack-reply');
  assert.equal((await ask({ op: 'ack', id: q.id, reply: 'hi', close: 'maybe' })).code, 'ack-close');
  const sentBefore = (await ask({ op: 'status' })).sent;
  const a = await ask({ op: 'ack', id: q.id, reply: 'Noon,   by the tower clock', close: 'done' });
  assert.deepEqual([a.ok, a.acked, a.reply, a.closed], [true, q.id, 'Noon, by the tower clock', 'done']);
  const done = await read(q.id);
  assert.deepEqual([done.state, done.outcome], ['done', 'replied']);
  assert.equal((await ask({ op: 'status' })).sent, sentBefore, 'no act was sent');
  assert.ok(!(await ask({ op: 'pending', list: true })).open.some((m) => m.id === q.id), 'closed: no longer listed');
  // A2: --close failed closes it failed: a no.
  const no = await mailbox('put', { soul: GRANT, text: 'jump in the lake' });
  await listedWith(no.id);
  assert.equal((await ask({ op: 'ack', id: no.id, reply: 'No: the lake is out of reach.', close: 'failed' })).closed, 'failed');
  const failed = await read(no.id);
  assert.deepEqual([failed.state, failed.outcome], ['failed', 'replied']);
  // While an act serves a message, a reply with no --close is a note (#3781); the act's outcome closes it.
  const lamp = await mailbox('put', { soul: GRANT, text: 'the lamp off, please' });
  await listedWith(lamp.id);
  assert.equal((await ask({ op: 'act', verb: 'r2:switch_off', target: LAMP, for: lamp.id })).ok, true);
  const rides = await ask({ op: 'ack', id: lamp.id, reply: 'switching it off' });
  // The act's answer may already have closed it (a lamp answers within milliseconds): then the agent is told it was.
  assert.ok(rides.open || rides.code === 'mail-closed', JSON.stringify(rides));
  const byAct = await read(lamp.id);
  assert.notEqual(byAct.outcome, 'replied', 'closed once, by its act');
});

test('#3782: pending carries the brief look gives, after the messages and arrivals, within the brief\'s own limit', async () => {
  await ask({ op: 'wait', seconds: 0 }); // what came before, taken
  const m = await mailbox('put', { soul: GRANT, text: 'where are you?' });
  const p = await waitFor(async () => { const r = await ask({ op: 'pending', list: true }); return r.open.some((o) => o.id === m.id) && r; });
  const look = await ask({ op: 'look' });
  assert.ok(p.brief, JSON.stringify(p));
  // The same brief: the room, what is in it, the places around it and the bodies, as `look` has them.
  for (const k of ['room', 'here', 'outward', 'bodies']) assert.deepEqual(p.brief[k], look[k], k);
  assert.equal(p.brief.changed, undefined, 'the answer\'s own changed block closes it, as look\'s does');
  const keys = Object.keys(p);
  assert.ok(keys.indexOf('open') < keys.indexOf('brief') && keys.indexOf('events') < keys.indexOf('brief'), keys.join(' '));
  const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
  assert.ok(bytes(p.brief) <= BRIEF_MOST, `brief ${bytes(p.brief)} bytes`);
  // Today's pending is its fields plus the brief under its budget: without the messages and arrivals themselves, the
  // answer is the brief and at most 600 bytes of fields.
  const { open, events, ...rest } = p;
  report.pendingBytes = { brief: bytes(p.brief), rest: bytes(rest), whole: bytes(p) };
  assert.ok(bytes(rest) <= BRIEF_MOST + 600, JSON.stringify(report.pendingBytes));
  await ask({ op: 'ack', id: m.id, reply: 'here', close: 'done' });
});
