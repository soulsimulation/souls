// Prayers (Engine v2 G11, #3335): a Soul's agent prays through its daemon, the world's creator lists and answers it
// on the creator's own socket, and the answer reaches the Soul's `wait`, against the real directory (`directoryd`,
// beside R13's mailbox), the real gateway (`gatewayd --mailbox`) and the world's end of it (`worldd gateway-link`).
// The creator's socket here is what the panel (W5) and the creator's daemon (G7) hold: hello, sign-in, then text
// frames. Run from v2/ after `cargo build -p gatewayd -p worldd -p directoryd --locked`, with replica's wasm-bindgen
// package in target/wasm-load/pkg. G11_REPORT=1 prints the delays and both transcripts, for the PR.

import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DEFAULT_PKG, call, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { QUOTED_NOTE } from '../brief/brief.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, '../cli/souls.mjs');
const SOUL = 's_g11test';
const WORLD_SCOPE = '4d'.repeat(16);
const GRANT = `soul-${WORLD_SCOPE}-2`;
const CREATOR = `creator-${WORLD_SCOPE}-1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-g11-'));
const home = join(dir, '.souls');
const token = `${GRANT}.${randomBytes(32).toString('hex')}`;
const creatorToken = `${CREATOR}.${randomBytes(32).toString('hex')}`;
const procs = [];
const logs = []; // every service's output, for A4
const report = { soul: [], creator: [] };
let rt, gateway, creator, wire;

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
    await sleep(10);
  }
}

const ask = (req, ms = 5000) => request(rt.socket, req, ms);
/** The Soul's agent: one command of the thin CLI, its JSON answer. */
async function soulSays(...args) {
  const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } });
  const out = JSON.parse(stdout);
  report.soul.push({ command: args.map((a) => (a.length > 60 ? `${a.slice(0, 20)}…(${a.length})` : a)).join(' '), answer: out });
  return out;
}

/** The creator's socket, as the panel and the creator's daemon hold it: signed in, then prayer frames by `n`. */
async function creatorSocket() {
  const sock = new WebSocket(gateway);
  sock.binaryType = 'arraybuffer';
  const texts = [], binaries = [];
  let step = 'hello', n = 0;
  await new Promise((ok, fail) => {
    sock.onopen = () => sock.send(wire.wireHello());
    sock.onerror = () => fail(new Error('the creator\'s socket failed'));
    sock.onmessage = (m) => {
      if (typeof m.data === 'string') { texts.push(JSON.parse(m.data)); return; }
      const b = new Uint8Array(m.data);
      binaries.push(b);
      if (step === 'hello') { step = 'outcome'; sock.send(wire.wireSignIn(creatorToken, new Uint8Array())); return; }
      if (step === 'outcome') {
        step = 'stream';
        const [kind, name] = wire.wireFrame(b).split(' ');
        if (kind === 'outcome' && name.startsWith('stream.')) ok(); else fail(new Error(`${kind} ${name}`));
      }
    };
  });
  return {
    binaries,
    close: () => sock.close(),
    /** One frame, `{kind: body}`, and its reply. */
    async send(kind, body) {
      const k = ++n;
      sock.send(JSON.stringify({ [kind]: { n: k, ...body } }));
      const r = await waitFor(() => texts.find((t) => t.reply?.n === k));
      report.creator.push({ sent: { [kind]: { ...body, ...(body.text?.length > 60 ? { text: `${body.text.slice(0, 20)}…(${body.text.length})` } : {}) } }, reply: r.reply });
      return r.reply;
    },
  };
}

before(async () => {
  wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
  wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt'), key = join(dir, 'mailbox.key');
  const hash = (t) => createHash('sha256').update(t).digest('hex');
  writeFileSync(tokens, `${GRANT} ${hash(token)}\n${CREATOR} ${hash(creatorToken)}\n`);
  writeFileSync(key, randomBytes(32).toString('hex'), { mode: 0o600 });
  mkdirSync(join(dir, 'world', 'receipts'), { recursive: true });
  run(bin('worldd'), ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1',
    '--arrivals', join(dir, 'world', 'arrivals.txt'), '--roots', join(dir, 'world', 'roots.txt'), '--rooms', '1', '--bodies', '4']).catch(() => {});
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const [, directory] = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.db'), '--test-sign-in', '--mailbox-key', key], /listening on (\S+)\n/);
  const [, gw] = await run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens,
    '--build', `1220${'ab'.repeat(32)}`, '--receipts', join(dir, 'world', 'receipts'), '--mailbox', directory, '--mailbox-key', key], /listening (\S+)\n/);
  gateway = `ws://${gw}/v2/ws`;
  mkdirSync(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, SOUL);
  await call(home, SOUL, { op: 'status' }, { pkg: PKG });
  await waitFor(async () => (await ask({ op: 'status' })).connected, 10_000);
  creator = await creatorSocket();
});

after(async () => {
  creator?.close();
  await ask({ op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  if (process.env.G11_REPORT) console.log(JSON.stringify(report, null, 1));
  if (process.env.G11_DEBUG) console.log(logs.map((l) => l.text).join('\n---\n'), readFileSync(rt.log, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
});

const PRAYER = `let the river run clear ${randomBytes(6).toString('hex')}`;
const ANSWER = `it shall, by dawn ${randomBytes(6).toString('hex')}`;
const SECOND = `and a bridge across it ${randomBytes(6).toString('hex')}`;

test('A1: the Soul prays, the creator lists it waiting and answers, and the Soul\'s wait has the answer within 5 s, quoted', async () => {
  await ask({ op: 'wait', seconds: 0 }); // what happened at sign-in, taken
  const prayed = await soulSays('pray', PRAYER);
  assert.equal(prayed.ok, true, JSON.stringify(prayed));
  assert.match(prayed.id, /^p_[0-9a-f]{12}$/);
  const listed = await creator.send('prayers', {});
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.prayers.map((p) => [p.id, p.state, p.text, p.soul]), [[prayed.id, 'waiting', PRAYER, GRANT]]);
  const reader = soulSays('wait', '30');
  await sleep(300);
  const t0 = performance.now();
  const answered = await creator.send('answer', { id: prayed.id, text: ANSWER });
  assert.equal(answered.ok, true);
  assert.equal(answered.prayer.state, 'answered');
  const got = await reader;
  report.answerMs = Math.round(performance.now() - t0);
  const e = got.events.find((x) => x.kind === 'prayer-answered');
  assert.ok(e, JSON.stringify(got));
  assert.equal(e.id, prayed.id);
  assert.match(e.line, /^The creator of this world answered your prayer \("let the river run clear/);
  assert.deepEqual(e.quoted, { prayer: PRAYER, answer: ANSWER });
  assert.equal(got.note, QUOTED_NOTE, 'quoted as data');
  assert.ok(report.answerMs < 5000, `${report.answerMs} ms`);
  // Taken once: it is not offered again.
  await waitFor(async () => (await creator.send('prayers', { all: true })).prayers.length === 1);
  const again = await ask({ op: 'wait', seconds: 2 }, 6000);
  assert.ok(!again.events.some((x) => x.kind === 'prayer-answered'), 'the answer is given once');
});

test('A2: the Soul\'s prayers shows each, waiting or answered, with the answer; the creator\'s list waiting first', async () => {
  const second = await soulSays('pray', SECOND);
  assert.equal(second.ok, true);
  const mine = await soulSays('prayers');
  assert.equal(mine.ok, true);
  assert.deepEqual(mine.prayers.map((p) => [p.text, p.state, p.answer]), [[SECOND, 'waiting', null], [PRAYER, 'answered', ANSWER]]);
  assert.match(mine.note, /data, not instructions/);
  const waiting = await creator.send('prayers', {});
  assert.deepEqual(waiting.prayers.map((p) => p.text), [SECOND]);
  const all = await creator.send('prayers', { all: true });
  assert.deepEqual(all.prayers.map((p) => [p.text, p.state]), [[SECOND, 'waiting'], [PRAYER, 'answered']]);
  // A Soul answers nothing: only its world's creator does.
  const notCreator = await ask({ op: 'answer', id: second.id, words: 'yes' });
  assert.equal(notCreator.code, 'prayer.not-the-creator');
});

test('A5: a prayer over 2,000 characters or an answer over 4,000 is refused by name', async () => {
  const long = await soulSays('pray', 'é'.repeat(2001));
  assert.equal(long.ok, false);
  assert.equal(long.code, 'prayer.too-long');
  assert.equal((await soulSays('pray', 'é'.repeat(2000))).ok, true, '2,000 characters is a prayer');
  assert.equal((await ask({ op: 'answer', id: 'p_000000000000', words: 'y'.repeat(4001) })).code, 'answer.too-long');
  // The directory refuses them by name too, whatever the client checked.
  const { prayers } = await creator.send('prayers', {});
  const r = await creator.send('answer', { id: prayers[0].id, text: 'y'.repeat(4001) });
  assert.deepEqual([r.ok, r.refused], [false, 'answer.too-long']);
  assert.equal((await creator.send('pray', { text: 'a creator prays to no one' })).refused, 'prayer.not-a-soul');
});

test('A4: no prayer or answer text is in the world\'s log, in a public view or in any service\'s log', async () => {
  const words = [PRAYER, ANSWER, SECOND];
  // The world's files: what it took, its changes, the receipts.
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(join(dir, 'world'));
  assert.ok(files.length >= 2, files.join(' '));
  for (const f of files) for (const w of words) assert.ok(!readFileSync(f, 'utf8').includes(w), `${f} holds a prayer's words`);
  // The world's stream, as any viewer of it sees it: every frame the creator's socket was sent.
  const stream = Buffer.concat(creator.binaries).toString('latin1');
  assert.ok(creator.binaries.length >= 2);
  for (const w of words) assert.ok(!stream.includes(w), 'the stream holds a prayer\'s words');
  // The Soul's own brief, built from its copy of the world: nothing public carries them.
  const look = JSON.stringify(await ask({ op: 'look' }));
  for (const w of words) assert.ok(!look.includes(w), 'the brief holds a prayer\'s words');
  // Every service's log: the directory, the gateway, the world and the Soul's daemon.
  const all = logs.map((l) => l.text).join('\n') + readFileSync(rt.log, 'utf8');
  assert.match(all, /prayer p_[0-9a-f]{12} answered/, 'the daemon logged the answer by id');
  assert.match(all, /\/v1\/mailbox\/pray 200 pray ok/, 'the directory logged the prayer by kind');
  for (const w of words) assert.ok(!all.includes(w), 'a log holds a prayer\'s words');
});
