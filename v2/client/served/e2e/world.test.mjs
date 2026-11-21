// The served-world end-to-end gate (#1960, CI v2-client leg): one real served world, two real Souls through the real
// pairing path, real acts through the thin command, and what a viewer and a client actually get. The defects it is
// built to catch all escaped tests that wrote the stream or the copy by hand (#3799, #3765, #3760, #2791, #3667).
//
// The world: N2's test world (`testworld`, generated, no 11 MB production facts) with an Eden slice added to it: an
// Eden bench and an Eden chair on the square (`eden:bench`, `eden:chair`), its twelve doors as Eden doors
// (`eden:door`), its named places (the square, the yard, the hall's aisles), and Eden's own entries for them and for
// the body's family (`content/kinds`). `worldd seed`, `worldd serve`, `gatewayd --entries`, `directoryd` as the C3
// pairing test starts them; two Souls paired by `pair.mjs` and approved once, each joined with `life:join`.
//
// The acts (the thin command, `souls.mjs`): A walks to the bench and sits on it, waves, says a sentence, whispers to
// B, and sends one malformed act word. The public stream is read by the page's own worker (`web/src/source/worker.ts`
// with the WASM replica), from the world's `views/world.json` as the page resolves a placed world.
//
//   (a) the public stream carries both bodies, the said sentence and not the whisper's words (in no part and in no
//       public file), a private conversation's turn as who spoke, when and among whom, never its words (#3775), a `souls:form-move` for the wave, and body motion: changing positions on the walk and a slot
//       hand-off on the sit;
//   (b) A's copy holds the world's kind entries after pairing, and `can wave:<A's body>` answers yes;
//   (c) the malformed word is refused by name, and the world then restarts cleanly on the same folder;
//   (d) after the restart a new viewer's stream holds the bodies where they were, and the stream goes on (a new say);
//   (e) hide-and-seek (#3915): A takes an apple from an Eden swap shelf and hides it in an Eden hollow stump, whose entry is
//       `closed`; B's copy, `find` and `look` no longer hold the apple at all, A's still do.
//
// PENDING markers. An assertion that waits on an open fix runs inside `pending(<issue>, ...)`. While the fix is open it
// fails, and the run prints `PENDING #<issue>: <what> (expected failure: <why>)` and goes on: never a silent skip. When
// it passes, the test FAILS with `PENDING #<issue> now passes: remove its marker`, so the fix's PR removes the marker
// in the same change and the assertion is required from then on.
//   #3772 (a Soul's body runs its family's forms, E21 #2791): the wave's `souls:form-move` in (a) and `can wave` in (b).
//
// Fake minds, isolated folders under the OS temp dir, no fixed sleeps (each wait is on an event, bounded as a failure
// backstop). Run from v2/ after
//   cargo build -p directoryd -p gatewayd -p worldd -p testworld --locked, replica's wasm-bindgen package in
//   target/wasm-load/pkg and `npm ci --prefix web` (v2/tools/ci.sh's client leg does all three).

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { request } from '../../src/daemon/client.mjs';
import { runtimeOf } from '../../src/home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const content = resolve(v2, '../content/kinds');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
const CLI = join(v2, 'client/src/cli/souls.mjs');
const WORKER = join(v2, 'web/src/source/worker.ts');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

for (const f of [join(PKG, 'replica.js'), bin('worldd'), bin('gatewayd'), bin('directoryd'), bin('testworld')]) {
  assert.ok(existsSync(f), `${f}: build it first (see the head of this file)`);
}
// The page's worker imports `replica` as the page's bundler names it.
const replicaUrl = pathToFileURL(join(PKG, 'replica.js')).href;
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: replicaUrl, shortCircuit: true } : next(s, c)) });

// ---- Pending markers ---------------------------------------------------------------------------------------------
const PENDING = {
  3772: "a Soul's body has no forms: its family's wave is refused and writes no souls:form-move",
};
const pendingReport = [];
/** Runs `check`; while `issue` is open a failure is expected and printed, a pass fails the run (remove the marker). */
async function pending(issue, what, check) {
  assert.ok(PENDING[issue], `pending #${issue} has no marker`);
  try {
    await check();
  } catch (err) {
    const line = `PENDING #${issue}: ${what} (expected failure: ${PENDING[issue]}): ${String(err.message).split('\n')[0].slice(0, 300)}`;
    console.log(line);
    pendingReport.push({ issue, what, failed: true });
    return;
  }
  pendingReport.push({ issue, what, failed: false });
  assert.fail(`PENDING #${issue} now passes: ${what}. Remove its marker in v2/client/served/e2e/world.test.mjs in the fix's PR.`);
}

// ---- Processes ---------------------------------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'souls-e2e-'));
const procs = [];
const outputs = [];
const daemons = [];
const timers = [];

function run(path, args, ready, opts = {}) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts, env: { PATH: process.env.PATH, BRAIN_MODE: 'fake', ...opts.env } });
  procs.push(p);
  let out = '';
  const done = new Promise((ok, fail) => {
    const take = (d) => { out += d; outputs.push(String(d)); const m = ready?.exec(out); if (m) ok({ p, m, out: () => out }); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => (ready ? fail(new Error(`${path} ended (${c}) before it was ready: ${out.slice(-2000)}`)) : ok({ p, out, code: c })));
  });
  done.p = p;
  done.text = () => out;
  return done;
}

async function waitFor(what, f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await pause(50);
  }
}

const freePort = () => new Promise((ok) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

after(async () => {
  timers.forEach(clearInterval);
  for (const d of daemons) await request(d.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill('SIGKILL');
  if (process.env.SERVED_E2E_KEEP !== '1') rmSync(dir, { recursive: true, force: true });
  else console.log(`kept: ${dir}`);
});

/** The thin command, as a harness runs it. */
function souls(home, ...args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { outputs.push(String(d)); });
    p.on('exit', () => { outputs.push(out); ok(JSON.parse(out.trim().split('\n').at(-1))); });
  });
}

// ---- The world ---------------------------------------------------------------------------------------------------
const BENCH = [0, 0, 6000], CHAIR = [4000, 0, 6000], STUMP = [-4000, 0, 6000], SHELF = [-2500, 0, 4500];

/** N2's test world with an Eden slice: an Eden bench and chair on the square, its doors as Eden doors. */
async function edenSlice() {
  const done = await run(bin('testworld'), ['--seed', '1', '--things', '0', '--out', dir]);
  assert.equal(done.code, 0, done.out);
  const facts = JSON.parse(readFileSync(join(dir, 'testworld-s1-t0.facts.json'), 'utf8'));
  facts.kinds.find((k) => k.ref === 'testworld-door@1').name = 'eden:door';
  const kind = (ref, name) => ({ ref, hash: Buffer.from(`souls/e2e/${ref}`).toString('hex').padEnd(64, '0').slice(0, 64), name, form: 'point' });
  facts.kinds.push(kind('e2e-bench@1', 'eden:bench'), kind('e2e-chair@1', 'eden:chair'), kind('e2e-stump@1', 'eden:hollow_stump'),
    kind('e2e-shelf@1', 'eden:swap_shelf'), kind('e2e-apple@1', 'eden:apple'));
  const thing = (id, def, pose, name, slots) => ({ id, def, ref: def, parent: null, pose, scale_ppm: 1_000_000, name, slots });
  const slot = (n, id, at) => ({ n, id, kind: 'seat', at, yaw: 0, capacity: 1 });
  facts.things.push(
    thing('bench-1', 'e2e-bench@1', [...BENCH, 0], 'the square bench', [slot(1, 'left', [-400, 465, 20]), slot(2, 'right', [400, 465, 20])]),
    thing('chair-1', 'e2e-chair@1', [...CHAIR, 0], 'the square chair', [slot(1, 'seat', [0, 470, 20])]),
    thing('stump-1', 'e2e-stump@1', [...STUMP, 0], 'the square stump', []),
    thing('shelf-1', 'e2e-shelf@1', [...SHELF, 0], 'the square shelf', [{ n: 1, id: 'shelf', kind: 'thing', at: [0, 1015, -10], yaw: 0, capacity: 3 }]),
    { ...thing('apple-1', 'e2e-apple@1', [0, 1015, -10, 0], 'an apple', []), parent: 'shelf-1', slot: { n: 1 } },
  );
  const path = join(dir, 'eden-slice.facts.json');
  writeFileSync(path, JSON.stringify(facts));
  // Eden's own entries for what the slice holds, and the body's family.
  const entries = join(dir, 'entries');
  mkdirSync(entries);
  for (const f of ['doors/door.json', 'seating/bench.json', 'seating/chair.json', 'body/humanoid.json', 'containers/hollow_stump.json', 'containers/swap_shelf.json', 'food/apple.json']) copyFileSync(join(content, f), join(entries, f.replace('/', '-')));
  return { facts: path, entries };
}

// ---- The page's worker on the world's public stream ----------------------------------------------------------------
/** What the page reads: the world's folder under `/w/eden/`, as the origin serves a placed world. */
let worldDir = null;
const misses = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input));
  if (url.protocol !== 'file:' && url.host !== 'local') return realFetch(input, init);
  if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
  const rest = decodeURIComponent(url.pathname).replace(/^\/w\/eden\//, '');
  const file = normalize(join(worldDir, rest));
  if (!file.startsWith(worldDir) || !existsSync(file) || !statSync(file).isFile()) { misses.add(url.pathname); return new Response(null, { status: 404 }); }
  return new Response(readFileSync(file));
});
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (f, ms) => { const t = realSetInterval(f, ms); timers.push(t); return t; };

/** A fresh viewer: the page's worker on the stream that `views/world.json` names. */
async function viewer(tag) {
  const named = JSON.parse(readFileSync(join(worldDir, 'views/world.json'), 'utf8'));
  const base = 'http://local/w/eden/';
  const stream = new URL(named.stream.replace(/\/?$/, '/'), base).href;
  const v = { parts: [], snapshots: [], errors: [], nodes: new Map(), stream };
  const self = {
    onmessage: null,
    postMessage: (m) => {
      if (m.t === 'part') { v.parts.push(m.p); for (const id of m.p.removed) v.nodes.delete(id); for (const n of m.p.nodes) v.nodes.set(n.id, n); }
      else if (m.t === 'snapshot') { v.snapshots.push(m.s); for (const id of m.s.removed) v.nodes.delete(id); for (const n of m.s.nodes) v.nodes.set(n.id, n); }
      else if (m.t === 'error') v.errors.push(m.message);
    },
  };
  globalThis.self = self;
  await import(`${pathToFileURL(WORKER).href}?${tag}`);
  self.onmessage({ data: { stream } });
  v.bodies = () => [...v.nodes.values()].filter((n) => n.kind.startsWith('souls:body'));
  return v;
}

/** The page's key for a client id (`<scope>-<counter>` → `<scope>.<counter>`). */
const pageKey = (id) => id.replace(/-(\d+)$/, '.$1');

test('served world end to end: two paired Souls act; viewers and clients get what they should; a restart keeps it', { timeout: 280_000 }, async () => {
  const t0 = Date.now();
  const stage = (s) => console.log(`e2e: ${s} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const w = await edenSlice();
  const world = join(dir, 'world');
  worldDir = world;
  const seeded = await run(bin('worldd'), ['seed', '--facts', w.facts, '--dir', world, '--souls', '0', '--at', '0,0', '--entries', w.entries]);
  assert.equal(seeded.code, 0, seeded.out);
  let served = run(bin('worldd'), ['serve', '--dir', world], /listening /);
  await served;
  const places = /places to sit or lie: (\d+) registered on (\d+) things/.exec(served.text());
  assert.ok(places && Number(places[1]) >= 3, `the bench's two seats and the chair's are registered: ${places?.[0]}`);
  stage('world served');

  const gwPort = await freePort();
  const gateway = `ws://127.0.0.1:${gwPort}/v2/ws`;
  await run(bin('gatewayd'), ['--listen', `127.0.0.1:${gwPort}`, '--world', join(world, 'gateway.sock'), '--tokens', join(world, 'tokens'),
    '--build', `1220${'ab'.repeat(32)}`, '--entries', join(world, 'entries')], /listening (\S+)\n/);
  const { m } = await run(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1',
    '--store', join(dir, 'accounts.sqlite'), '--test-sign-in', '--pairing', join(dir, 'pairing.sqlite'),
    '--gateway-tokens', join(world, 'tokens')], /listening on (\S+)\n/);
  const directory = `http://${m[1]}`;

  // Two Souls through the real pairing path: the client asks, the owner approves once, the token comes back.
  async function pairOne(label) {
    const folder = join(dir, label);
    mkdirSync(folder);
    const home = join(folder, '.souls');
    const asking = run(process.execPath, [join(v2, 'client/src/pair/pair.mjs'), '--directory', directory, '--world', 'local',
      '--gateway', gateway, '--device', 'e2e machine', '--label', label], null, { cwd: folder, env: { SOULS_HOME: home } });
    const asked = await waitFor(`${label}'s pairing code`, () => asking.text().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve'));
    const approve = await fetch(new URL('/v1/pair/approve', directory), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: asked.code, confirm: true, test_person: label }) });
    assert.equal(approve.status, 200, `${label}: the owner's approval`);
    const done = await asking;
    assert.equal(done.code, 0, done.out);
    const said = JSON.parse(done.out.trim().split('\n').at(-1));
    const rt = runtimeOf(home, said.soul);
    daemons.push(rt);
    return { label, home, soul: said.soul, rt, cli: (...a) => souls(home, ...a, '--soul', said.soul) };
  }
  // An act's answer from the world: the daemon's `read` events, by the act's sequence.
  async function answered(s, sequence, ms = 30_000) {
    s.seen ??= [];
    return waitFor(`${s.label}'s answer to intent ${sequence}`, async () => {
      s.seen.push(...(await request(s.rt.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer'));
      return s.seen.find((e) => e.sequence === sequence);
    }, ms);
  }
  /** The first event of `s`'s daemon that `pred` holds of; answers read on the way are kept for `answered`. */
  async function event(s, what, pred, ms = 30_000) {
    s.seen ??= [], s.other ??= [];
    return waitFor(what, async () => {
      for (const e of (await request(s.rt.socket, { op: 'read' })).events) (e.kind === 'answer' ? s.seen : s.other).push(e);
      return s.other.find(pred);
    }, ms);
  }
  /** Sends a CLI command and waits for the world's answer to each intent it sent. */
  async function sent(s, ...words) {
    const r = await s.cli(...words);
    assert.equal(r.ok, true, `${s.label} ${words.join(' ')}: ${JSON.stringify(r)}`);
    const seqs = Array.isArray(r.sent) ? r.sent.map((x) => x.sequence) : [r.sequence];
    return Promise.all(seqs.map((q) => answered(s, q)));
  }
  async function act(s, ...words) {
    const r = await s.cli('act', ...words);
    assert.equal(r.ok, true, `${s.label} act ${words.join(' ')}: ${JSON.stringify(r)}`);
    return { sent: r, answer: await answered(s, r.sequence) };
  }
  // C4's answer kinds: 1 receipt, 2 refused, 3 accepted, 4 resolved, 5 unread.
  const accepted = (a) => a.answer === 1 || a.answer === 3;
  const bodiesSeen = async (s) => (await s.cli('find', 'body', '--limit', '50')).found?.filter((r) => r.kind?.startsWith('souls:body')) ?? [];

  const A = await pairOne('alder');
  const B = await pairOne('birch');
  stage('two Souls paired');

  // (b) The copy after pairing holds the world's kinds.
  const kindFiles = readdirSync(join(A.home, 'kinds')).filter((f) => f.endsWith('.json'));
  const heldKinds = kindFiles.map((f) => JSON.parse(readFileSync(join(A.home, 'kinds', f), 'utf8')).kind);
  for (const k of ['eden:bench', 'eden:chair', 'eden:door', 'eden:humanoid']) assert.ok(heldKinds.includes(k), `(b) A's copy holds ${k}: ${heldKinds.join(', ')}`);

  // Both join; each body is the one its own copy did not know before.
  const joinA = await act(A, 'life:join');
  assert.ok(accepted(joinA.answer), `A's join: ${JSON.stringify(joinA.answer)}`);
  const meA = (await waitFor("A's body in A's copy", async () => (await bodiesSeen(A)).at(0))).id;
  const joinB = await act(B, 'life:join');
  assert.ok(accepted(joinB.answer), `B's join: ${JSON.stringify(joinB.answer)}`);
  const meB = (await waitFor("B's body in B's copy", async () => (await bodiesSeen(B)).find((r) => r.id !== meA))).id;
  stage(`joined: A ${meA}, B ${meB}`);

  // The page's viewer, from the start of the acts.
  const v1 = await viewer('before');
  await waitFor('both bodies in the public stream', () => v1.bodies().length >= 2 && v1.errors.length === 0 || v1.errors.length, 20_000);
  assert.deepEqual(v1.errors, [], 'the worker plays the stream');
  for (const me of [meA, meB]) assert.ok(v1.nodes.has(pageKey(me)), `(a) the public stream carries ${me}'s body: ${v1.bodies().map((n) => n.id)}`);
  stage('viewer has both bodies');

  // (b) can wave on my own body, from the copy alone.
  const can = await A.cli('can', `wave:${meA}`);
  await pending(3772, '(b) `can wave:<me>` answers yes from the copy', () => assert.equal(can.can ?? can.answer ?? can.verdict, 'yes', JSON.stringify(can)));

  // #3775: a private conversation. A offers B one where they stand (a seat admits no conversation), B accepts and
  // takes a private turn.
  const hidden = 'the boat leaves at the second bell';
  const offer = await sent(A, 'converse', 'start', meB);
  assert.ok(offer.every(accepted), `the offer lands: ${JSON.stringify(offer)}`);
  const invite = await event(B, "B's invitation", (e) => e.kind === 'conversation' && e.what === 'invited');
  assert.ok((await sent(B, 'converse', 'accept', invite.conversation)).every(accepted), 'the accept lands');
  assert.ok((await sent(B, 'converse', 'say', invite.conversation, hidden, '--private')).every(accepted), 'the private turn lands');
  stage('private turn answered');

  // (e) Hide-and-seek (#3915): before the hide both copies hold the apple; after it only the hider's does.
  const apples = async (s) => ((await s.cli('find', 'apple', '--limit', '50')).found ?? []).filter((r) => r.kind?.startsWith('eden:apple'));
  const apple = (await waitFor("the apple on the shelf in B's copy", async () => (await apples(B)).at(0))).id;
  const shelf = (await A.cli('find', 'shelf')).found.find((r) => r.kind?.startsWith('eden:swap_shelf'));
  assert.ok(shelf, 'the shelf is found by its words');
  const took = await act(A, `take:${shelf.id}`, `thing=${apple}`);
  assert.ok(accepted(took.answer), `A takes the apple from the shelf: ${JSON.stringify(took.answer)}`);
  const stump = (await A.cli('find', 'stump')).found.find((r) => r.kind?.startsWith('eden:hollow_stump'));
  assert.ok(stump, 'the stump is found by its words');
  const hid = await act(A, `hide:${stump.id}`, `thing=${apple}`);
  assert.ok(accepted(hid.answer), `A hides the apple in the stump: ${JSON.stringify(hid.answer)}`);
  await waitFor("the apple in the stump in A's copy", async () => (await apples(A)).find((r) => r.id === apple && r.in?.startsWith(stump.name)), 20_000);
  const seekerSees = await apples(B);
  console.log(`e2e: (e) after the hide, A's find: ${JSON.stringify((await apples(A)).map((r) => [r.id, r.in]))}; B's: ${JSON.stringify(seekerSees.map((r) => [r.id, r.in]))}`);
  assert.deepEqual(seekerSees.filter((r) => r.id === apple), [], "(e) B's find does not hold the hidden apple");
  const lookB = JSON.stringify(await B.cli('look'));
  assert.ok(!lookB.includes(apple), "(e) B's look does not name the hidden apple");
  const streamB = JSON.stringify((await request(B.rt.socket, { op: 'read' })).events);
  assert.ok(!streamB.includes(apple), "(e) no event B's daemon was handed names the hidden apple");
  stage('hidden apple withheld from the seeker');

  // The acts. A walks to the bench and sits on it.
  const bench = (await A.cli('find', 'bench')).found.find((r) => r.kind?.startsWith('eden:bench'));
  assert.ok(bench, 'the bench is found by its words');
  const fromPart = v1.parts.length;
  const walk = await act(A, bench.id);
  assert.ok(accepted(walk.answer), `A's walk to the bench: ${JSON.stringify(walk.answer)}`);
  const sit = await act(A, `sit:${bench.id}`);
  assert.ok(accepted(sit.answer), `A's sit on the bench: ${JSON.stringify(sit.answer)}`);
  const wave = await act(A, `wave:${meA}`);
  const words = 'the bread is still warm on the square';
  const secret = 'the key is under the third stone';
  const say = await A.cli('say', words);
  assert.equal(say.ok, true, JSON.stringify(say));
  const whisper = await A.cli('whisper', meB, secret);
  assert.equal(whisper.ok, true, JSON.stringify(whisper));
  const sayAnswer = await answered(A, say.sequence);
  const whisperAnswer = await answered(A, whisper.sequence);
  assert.ok(accepted(sayAnswer) && accepted(whisperAnswer), `say ${JSON.stringify(sayAnswer)}, whisper ${JSON.stringify(whisperAnswer)}`);
  stage('acts answered');

  // (c) One malformed act word (#3765's): refused by name, and nothing the log's reader refuses is written.
  const bad = await A.cli('act', 'sit_down:undefined');
  const badAnswer = bad.ok ? await answered(A, bad.sequence) : bad;
  console.log(`e2e: the malformed word: ${JSON.stringify(bad)} answered ${JSON.stringify(badAnswer)}`);
  assert.equal(badAnswer.answer, 2, `(c) the malformed word is refused: ${JSON.stringify(badAnswer)}`);
  assert.equal(badAnswer.reason, 'intent.not-a-form-on-a-node', '(c) refused by name');

  // (a) The public stream: the said sentence, and not the whisper's words.
  await waitFor('the said sentence in the public stream', () => v1.parts.some((p) => p.said?.some((s) => s.words === words)) || v1.errors.length, 20_000);
  assert.deepEqual(v1.errors, []);
  const heard = v1.parts.flatMap((p) => p.said ?? []).find((s) => s.words === words);
  assert.ok(heard, '(a) the said sentence reached the page');
  assert.equal(heard.speaker, pageKey(meA), '(a) said by A\'s body');
  assert.ok(!v1.parts.some((p) => (p.said ?? []).some((s) => s.words?.includes('third stone'))), '(a) the whisper is in no part the page played');
  // #3775: the private turn reaches the page as its record: B spoke, among A and B, with no words.
  const record = await waitFor('the private turn\'s record in the public stream', () => v1.parts.flatMap((p) => p.said ?? []).find((s) => s.private) || v1.errors.length, 20_000);
  assert.deepEqual(v1.errors, []);
  assert.equal(record.speaker, pageKey(meB), '#3775: said by B');
  assert.equal(record.private.conversation, pageKey(invite.conversation), '#3775: in the conversation');
  assert.deepEqual([...record.private.members].sort(), [pageKey(meA), pageKey(meB)].sort(), '#3775: among A and B');
  assert.equal(record.words, null, '#3775: no words');
  assert.ok(!v1.parts.some((p) => (p.said ?? []).some((s) => s.words?.includes('second bell'))), '#3775: the private words are in no part the page played');
  const publicFiles = (root) => existsSync(root) ? readdirSync(root, { recursive: true }).map((f) => join(root, f)).filter((f) => statSync(f).isFile()) : [];
  for (const f of [...publicFiles(join(world, 'views')), ...publicFiles(join(world, 'history'))]) {
    assert.ok(!readFileSync(f).includes(Buffer.from('third stone')), `(a) the whisper's words are in no public file: ${f.slice(world.length)}`);
    assert.ok(!readFileSync(f).includes(Buffer.from('second bell')), `#3775: the private words are in no public file: ${f.slice(world.length)}`);
  }

  // (a) The wave's move record, from the body's family.
  await pending(3772, "(a) the wave is accepted and its souls:form-move reaches the public stream", async () => {
    assert.ok(accepted(wave.answer), `the wave: ${JSON.stringify(wave.answer)}`);
    await waitFor('souls:form-move', () => v1.parts.some((p) => (p.happened ?? []).some((h) => h.name === 'souls:form-move' && h.node === pageKey(meA))), 10_000);
  });

  // (a) Body motion: positions change on the walk, and the sit hands the body off to the bench's slot.
  const a = pageKey(meA), benchKey = pageKey(bench.id);
  const seen = v1.parts.slice(fromPart).flatMap((p) => p.samples.filter((s) => s[0] === a).map((s) => s.slice(4).join(',')));
  assert.ok(new Set(seen).size >= 3, `(a) A's body moved through at least three positions on the walk: ${seen.length} samples, ${new Set(seen).size} distinct`);
  const seat = v1.parts.slice(fromPart).flatMap((p) => p.samples.filter((s) => s[0] === a && s[1] === benchKey && s[2] !== null));
  assert.ok(seat.length >= 1, '(a) a sample hands A\'s body to a bench slot');
  await waitFor("A's body on the bench", () => v1.nodes.get(a)?.parent === benchKey && v1.nodes.get(a)?.slot !== null, 5_000);

  // (c) The world restarts cleanly on the same folder, after the malformed word.
  const before = new Map(v1.bodies().map((n) => [n.id, { parent: n.parent, slot: n.slot, pos: n.pos }]));
  const copyRows = async () => JSON.stringify((await bodiesSeen(A)).map((r) => [r.id, r.parent, r.soul]).sort());
  const copyBefore = await copyRows();
  timers.splice(0).forEach(clearInterval);
  const stopped = new Promise((ok) => served.p.once('exit', (code, signal) => ok({ code, signal })));
  served.p.kill('SIGTERM');
  console.log(`e2e: worldd stopped: ${JSON.stringify(await stopped)}`);
  served = run(bin('worldd'), ['serve', '--dir', world], /listening /);
  await served;
  const started = /worldd: started at tick (\d+) state (\S+)/.exec(served.text());
  assert.ok(started, `(c) the world restarts: ${served.text().slice(-1500)}`);
  assert.ok(!/text-not-a-name|did not start|log failed/.test(served.text()), `(c) the restart reads its whole log: ${served.text().slice(-1500)}`);
  stage(`restarted at tick ${started[1]}`);

  // (d) A new viewer: the bodies where they were.
  const v2view = await viewer('after');
  await waitFor('both bodies after the restart', () => v2view.bodies().length >= 2 || v2view.errors.length, 20_000);
  assert.deepEqual(v2view.errors, [], 'the worker plays the stream after the restart');
  const afterRestart = new Map(v2view.bodies().map((n) => [n.id, { parent: n.parent, slot: n.slot, pos: n.pos }]));
  assert.deepEqual([...afterRestart.keys()].sort(), [...before.keys()].sort(), '(d) the same bodies after the restart');
  const where = (m) => JSON.stringify([...m].sort().map(([id, b]) => [id, b.parent, b.slot, b.pos]));
  console.log(`e2e: bodies before the restart ${where(before)}; after ${where(afterRestart)}`);
  // A seat is a motion frame (the bench's slot): the sit shows through #3799's samples.
  assert.equal(where(afterRestart), where(before), '(d) each body is where the stream had it before the restart');
  assert.equal(afterRestart.get(a).parent, benchKey, '(d) A seated on the bench');

  // (d) The stream goes on: a client reconnects and a new say reaches the new viewer.
  await waitFor('A\'s daemon to reconnect', async () => (await request(A.rt.socket, { op: 'status' }).catch(() => null))?.connected, 30_000);
  await waitFor("A's copy to hold the same bodies, in the same places, after the restart", async () => (await copyRows()) === copyBefore, 20_000);
  const again = 'and the kettle is on again';
  const said2 = await A.cli('say', again);
  assert.equal(said2.ok, true, JSON.stringify(said2));
  assert.ok(accepted(await answered(A, said2.sequence)), 'the say after the restart is answered');
  await waitFor('the say after the restart in the public stream', () => v2view.parts.some((p) => p.said?.some((s) => s.words === again)) || v2view.errors.length, 20_000);
  assert.deepEqual(v2view.errors, []);
  stage('stream continues after the restart');

  console.log(`e2e: pending markers: ${JSON.stringify(pendingReport)}; misses ${JSON.stringify([...misses].slice(0, 5))}`);
  console.log(`e2e: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
});
