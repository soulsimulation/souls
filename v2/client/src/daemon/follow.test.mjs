// The daemon follows the world's stream (Engine v2 R9b, #3201): B's daemon, subscribed through R4's stream, keeps its
// copy current from the entries of the bodies near it while two other Souls act; a reflex of B's fires on another
// Soul's event and the world accepts its intent, never on B's own; a drop resumes by hash and fires nothing twice.
// On the real gateway (`gatewayd`, I1) and the world's end of it (`worldd gateway-link`, I3's world of lamps, three
// bodies 0.2 m apart); A and C sign in on the gateway's socket as any client does and act by script, B through a
// TCP relay the test cuts. Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// R9B_SECONDS sets how long A and C act for A1 (default 15; the PR's run is 600). R9B_REPORT=1 prints the counts.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PKG, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { readLog, soulDirOf } from '../memory/memory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, '../cli/souls.mjs');
const SECONDS = Number(process.env.R9B_SECONDS ?? 15);
const PACE_MS = 250; // between A1's acts: a scripted pace, about four acts a second
// `worldd gateway-link`'s world mints from scope 2b: the place, the room, then each body and its lamp.
const WORLD_SCOPE = '2b'.repeat(16);
const body = (k) => `${WORLD_SCOPE}-${2 + 2 * k}`;
const lamp = (k) => `${WORLD_SCOPE}-${3 + 2 * k}`;
const B = 's_r9bb';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wire = await import(pathToFileURL(join(PKG, 'replica.js')).href);
wire.initSync({ module: readFileSync(join(PKG, 'replica_bg.wasm')) });

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'souls-r9b-'))); // memory refuses a path through a link
const home = join(dir, '.souls');
const procs = [];
const token = (k) => `soul-${body(k)}.${randomBytes(32).toString('hex')}`;
const tokens = [0, 1, 2].map(token); // A is body 0, B body 1, C body 2
const env = { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG };
let relay, roots, arrivals, gateway, rt;
const children = [];

/** Keep only bounded child diagnostics; redact the fixture's paths and addresses before reporting them. */
function tracked(bin, args) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  const state = { name: bin === WORLDD ? 'worldd' : 'gatewayd', exit: null, stdout: '', stderr: '' };
  children.push(state);
  for (const stream of ['stdout', 'stderr']) p[stream].on('data', (d) => { state[stream] = (state[stream] + d).slice(-2048); });
  p.on('exit', (code, signal) => { state.exit = { code, signal }; });
  return p;
}

function diagnostic(answer) {
  let text = JSON.stringify({ answer, children });
  for (const [path, name] of [[dir, '<fixture>'], [WORLDD, 'worldd'], [GATEWAYD, 'gatewayd'], [v2, '<checkout>']]) text = text.replaceAll(path, name);
  return text.replaceAll(/(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, '<test-address>');
}

function run(bin, args, ready) {
  const p = tracked(bin, args);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = ready.exec(out); if (m) ok(m); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => fail(new Error(`${bin} ended (${c}): ${out}`)));
  });
}

async function waitFor(f, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out\n${readFileSync(rt.log, 'utf8').split('\n').slice(-20).join('\n')}\n${diagnostic()}`);
    await sleep(10);
  }
}

/** A TCP relay to the gateway: `cut()` closes every connection; `refuse` closes each new one at once. */
function makeRelay(port) {
  const pairs = new Set();
  const r = { refuse: false, cut: () => { for (const [a, b] of pairs) { a.destroy(); b.destroy(); } pairs.clear(); } };
  r.server = createServer((down) => {
    if (r.refuse) { down.destroy(); return; }
    const up = createConnection(port, '127.0.0.1');
    pairs.add([down, up]);
    down.pipe(up);
    up.pipe(down);
    for (const s of [down, up]) { s.on('error', () => {}); s.on('close', () => { down.destroy(); up.destroy(); }); }
  });
  return new Promise((ok) => r.server.listen(0, '127.0.0.1', () => { r.port = r.server.address().port; ok(r); }));
}

/** Another Soul on the gateway's socket, signed in as body `k`: `act(verb, words)` resolves with the world's answer. */
async function soulOn(k) {
  const ws = new WebSocket(gateway);
  ws.binaryType = 'arraybuffer';
  const waiting = new Map();
  let signed, sequence = 0;
  const signedIn = new Promise((ok) => { signed = ok; });
  ws.onopen = () => ws.send(wire.wireHello());
  let step = 'hello', closed = null;
  const seen = []; // the last frames, for a failure's message
  ws.onmessage = (m) => {
    const bytes = new Uint8Array(m.data);
    if (step === 'hello') { wire.wireWorldBuild(bytes); ws.send(wire.wireSignIn(tokens[k], new Uint8Array(), undefined)); step = 'outcome'; return; }
    const line = wire.wireFrame(bytes);
    seen.push(line);
    if (seen.length > 10) seen.shift();
    const [kind, a, , c, d] = line.split(' ');
    if (kind === 'outcome') { step = 'stream'; signed(a); return; }
    if (kind === 'answer') { waiting.get(Number(a))?.({ answer: Number(c), reason: d }); waiting.delete(Number(a)); }
  };
  ws.onclose = (e) => { closed = e.code; };
  await signedIn;
  const scope = new Uint8Array(Buffer.from(WORLD_SCOPE, 'hex'));
  return {
    act(verb, words) {
      const s = ++sequence;
      ws.send(wire.wireIntent(scope, BigInt(2 + 2 * k), verb, BigInt(s), new Uint8Array(), BigInt(Number.MAX_SAFE_INTEGER), '', words, undefined));
      return new Promise((ok, fail) => {
        const t = setTimeout(() => fail(new Error(`no answer to ${s} (closed ${closed}): ${seen.join(' | ')}`)), 10_000);
        waiting.set(s, (a) => { clearTimeout(t); ok(a); });
      });
    },
    close: () => ws.close(),
  };
}

const placeHash = () => readFileSync(roots, 'utf8').split('\n').filter(Boolean).at(-1)?.split(' ')[1];
const firings = [], events = []; // every reflex firing and event B's answers gave, in order
/** A command to B's daemon; the firings each answer shows in `changed` and the events a read gives are kept. */
async function ask(req) {
  const a = await request(rt.socket, req);
  firings.push(...(a.changed?.reflexes ?? []));
  events.push(...(req.op === 'read' ? a.events : []));
  return a;
}
const status = () => ask({ op: 'status' });
/** B's copy holds the world's place: its hash is the one the world wrote after its last change. */
const current = async () => { const s = await status(); return s.connected && !s.syncing && Object.values(s.roots)[0] === placeHash() && s; };
let A, C;

before(async () => {
  const world = join(dir, 'w.sock'), list = join(dir, 'tokens.txt');
  roots = join(dir, 'roots.txt');
  arrivals = join(dir, 'arrivals.txt');
  writeFileSync(list, tokens.map((t) => `${t.split('.')[0]} ${createHash('sha256').update(t).digest('hex')}\n`).join(''));
  tracked(WORLDD, ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--roots', roots, '--arrivals', arrivals, '--rooms', '1', '--bodies', '3', '--items', '0', '--no-measures']);
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const [, addr] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', list, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  gateway = `ws://${addr}/v2/ws`;
  relay = await makeRelay(Number(addr.split(':').pop()));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://127.0.0.1:${relay.port}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [B]: { local: { token: tokens[1] } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rt = runtimeOf(home, B);
  const r = spawnSync(process.execPath, [CLI, 'status', '--soul', B], { env, encoding: 'utf8' }); // starts B's daemon
  assert.equal(r.status, 0, r.stdout + r.stderr);
  await waitFor(async () => { const s = await status(); return s.connected && !s.syncing; });
  [A, C] = await Promise.all([soulOn(0), soulOn(2)]);
});

after(async () => {
  await request(rt.socket, { op: 'stop' }).catch(() => {});
  A?.close(); C?.close();
  relay?.server.close();
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('R9b A1: B applies the entries of the Souls near it; its copy is the world after their scripted acts', async () => {
  const before = await status();
  let acts = 0, most = 0;
  const until = performance.now() + SECONDS * 1000;
  while (performance.now() < until) {
    // A and C each give their body a new name in turn: an entry of a body near B, which changes the world.
    const who = acts % 2 === 0 ? A : C, was = placeHash();
    const a = await who.act('local:describe', `name ${acts}`);
    assert.equal(a.answer, 1, `a describe is a receipt: ${diagnostic(a)}`);
    acts++;
    // B's copy is current with no command asking for it: `status` reads it as it is.
    const t = performance.now();
    await waitFor(() => placeHash() !== was, 5000);
    await waitFor(current, 5000);
    most = Math.max(most, performance.now() - t);
    await sleep(PACE_MS);
  }
  const s = await waitFor(current);
  assert.ok(s.entries >= acts, `entries ${s.entries} of ${acts} acts`);
  assert.ok(s.follows > before.follows, `follows ${s.follows}`);
  if (process.env.R9B_REPORT) console.log(JSON.stringify({ seconds: SECONDS, acts, entries: s.entries, follows: s.follows, mostMs: Math.round(most), root: placeHash() }));
});

test('R9b A2: a reflex fires on another Soul\'s event in the item that brings it, and the world takes its intent; never on its own', async () => {
  const rule = { when: { event: 'souls:said' }, send: { verb: 'r2:switch_on', target: lamp(1) }, expires: 600, cooldown: 0 };
  assert.equal((await ask({ op: 'reflex', do: 'add', rule })).ok, true);
  await ask({ op: 'read' });
  const { answered } = await status();
  firings.length = events.length = 0;
  // A says a line: B's reflex fires on it, with no model turn, and sends its intent.
  const said = await A.act('local:say', 'good morning');
  assert.equal(said.answer, 1, diagnostic(said));
  const got = await waitFor(async () => { const s = await status(); return s.answered > answered && s; });
  await ask({ op: 'read' });
  const heard = events.filter((e) => e.kind === 'heard');
  assert.deepEqual(heard.map((e) => [e.from, e.words]), [[body(0), 'good morning']]);
  // It fired once, on the event that item carried.
  assert.deepEqual(firings.map((f) => [f.event, f.sequence, f.intent.verb]), [['souls:said', heard[0].sequence, 'r2:switch_on']]);
  // The same event reached R14's memory feeder: B remembers what A said, marked as the world's words.
  assert.ok(JSON.stringify(readLog(soulDirOf(home, B))).includes('good morning'), 'in memory');
  // The world takes its intent: answered as a receipt, nothing left unanswered.
  assert.deepEqual(got.unanswered, []);
  const answers = events.filter((e) => e.kind === 'answer');
  assert.ok(answers.length === 1 && answers[0].answer === 1 && !answers[0].reason, JSON.stringify(answers));
  // B says a line itself: the rule never fires on its own event.
  const own = await ask({ op: 'say', words: 'and to you' });
  assert.equal(own.ok, true);
  await sleep(1000);
  const list = await ask({ op: 'reflex' });
  assert.equal(firings.length, 1, JSON.stringify(firings));
  assert.equal(list.reflexes[0].fired, 1);
  // #3764: the world took the reflex's intent marked as one, and B's own say (its agent's act) and A's unmarked.
  const lines = readFileSync(arrivals, 'utf8').trim().split('\n');
  const marked = lines.filter((l) => l.endsWith(' reflex'));
  assert.equal(marked.length, 1, lines.join(' | '));
  const [key, sequence] = marked[0].split(' ');
  assert.equal(Number(sequence), answers[0].sequence, `the reflex's own intent: ${marked[0]}`);
  assert.ok(lines.includes(`${key} ${own.sequence}`), `B's say arrived unmarked: ${lines.join(' | ')}`);
  if (process.env.R9B_REPORT) console.log(JSON.stringify({ reflexArrival: marked[0].split(' ').slice(1), agentArrival: own.sequence, arrivals: lines.length }));
});

test('R9b A3: losing and regaining the stream resumes by hash and fires no reflex twice', async () => {
  const s0 = await status();
  firings.length = 0;
  // While B is cut off, A renames its body and C says a line: B misses both items.
  relay.refuse = true;
  relay.cut();
  await waitFor(async () => !(await status()).connected);
  const was = placeHash();
  const renamed = await A.act('local:describe', 'renamed while away');
  assert.equal(renamed.answer, 1, diagnostic(renamed));
  const said = await C.act('local:say', 'said while away');
  assert.equal(said.answer, 1, diagnostic(said));
  await waitFor(() => placeHash() !== was);
  relay.refuse = false;
  const s = await waitFor(async () => { const x = await status(); return x.resumed > s0.resumed && x.connected && x; });
  // Resumed by its cursor, then brought current by hash: the copy is the world's place, with no command asking.
  assert.equal(s.cannotResume, s0.cannotResume);
  await waitFor(current);
  assert.ok((await status()).follows > s0.follows);
  // The line said while away is not replayed; the next one fires the rule once, and nothing fires twice.
  const back = await A.act('local:say', 'welcome back');
  assert.equal(back.answer, 1, diagnostic(back));
  await waitFor(async () => { await status(); return firings.length > 0; });
  await sleep(1000);
  const list = await ask({ op: 'reflex' });
  assert.deepEqual(firings.map((f) => f.event), ['souls:said'], JSON.stringify(firings));
  assert.equal(list.reflexes[0].fired, 2);
});

test('G-late: an answer that brings the copy current waits for what was owed when it was asked, not for entries named since', async () => {
  // A renames its body as fast as the world answers: entries of a body near B keep naming newer versions while B's
  // copy syncs. B's `look` (an act's own check is the same refresh) must not chase them: before, it waited for the
  // newest version any entry named, which a busy world never let it reach, and each answer took all of REFRESH_WITHIN.
  let going = true, n = 0;
  const busy = (async () => { while (going) { const a = await A.act('local:describe', `busy ${n++}`); assert.equal(a.answer, 1, diagnostic(a)); } })();
  await sleep(500);
  const took = [];
  for (let k = 0; k < 5; k++) {
    const t = performance.now(), a = await ask({ op: 'look' });
    took.push(Math.round(performance.now() - t));
    assert.equal(a.ok, true);
    assert.ok(!a.stale, `a look answered from a current copy: ${JSON.stringify({ stale: a.stale, gap: a.gap })}`);
    await sleep(100);
  }
  going = false;
  await busy;
  if (process.env.R9B_REPORT) console.log(JSON.stringify({ lookMs: took, renames: n }));
  // A sync is a few round trips, and a follow again 250 ms on (the world's seal); 2000 ms is REFRESH_WITHIN, its cap.
  assert.ok(Math.max(...took) < 1000, `each look within 1 s while the world is busy: ${took.join(', ')} ms (${n} renames)`);
});
