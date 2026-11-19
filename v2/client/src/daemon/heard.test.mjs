// A Soul hears (Engine v2 C6, #3390): speech to it and near it reaches its agent. Three Souls on the real gateway
// (`gatewayd`, I1) and the world's end of it (`worldd gateway-link`, I4's world of lamps, three bodies 0.2 m apart),
// each driven through the thin command (`souls.mjs`). A says a sentence and B's `wait` returns it with its words; A
// whispers to C and C hears it, B never does; B's next brief shows what was said near it since its last turn; a
// reflex of B's fires on what it heard. Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// C6_REPORT=1 prints the lag of each sentence, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request } from './client.mjs';
import { runtimeOf } from '../home/home.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, '../cli/souls.mjs');
// `worldd gateway-link`'s world mints from scope 2b: the place, the room, then each body and its lamp.
const WORLD_SCOPE = '2b'.repeat(16);
const body = (k) => `${WORLD_SCOPE}-${2 + 2 * k}`;
const A = 's_c6a', B = 's_c6b', C = 's_c6c';
// The stream's lag (V1's A3 bound): a sentence said reaches a hearer's agent within it.
const LAG_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-c6-'));
const home = join(dir, '.souls');
const procs = [];
const seats = [A, B, C].map((soul, k) => ({ soul, grant: `soul-${body(k)}`, token: `soul-${body(k)}.${randomBytes(32).toString('hex')}` }));
const env = { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG };

function run(bin, args, ready) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
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
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

/** The thin command, as a harness runs it. */
function souls(soul, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--soul', soul], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

/** The thin command run in the background (a `wait`): its answer, and when it was printed. */
function soulsLater(soul, ...args) {
  const p = spawn(process.execPath, [CLI, ...args, '--soul', soul], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (c) => (c === 0 ? ok({ answer: JSON.parse(out), at: performance.now() }) : fail(new Error(out))));
  });
}

const heardIn = (answer) => (answer.events ?? []).filter((e) => e.kind === 'heard');

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, seats.map((s) => `${s.grant} ${createHash('sha256').update(s.token).digest('hex')}\n`).join(''));
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', '3', '--items', '0'], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const [, addr] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${addr}/v2/ws` } } }));
  const souls_ = Object.fromEntries(seats.map((s) => [s.soul, { local: { token: s.token } }]));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: souls_ }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  for (const s of seats) souls(s.soul, 'status'); // the first command starts each daemon
  for (const s of seats) {
    await waitFor(async () => { const st = await request(runtimeOf(home, s.soul).socket, { op: 'status' }); return st.connected && !st.syncing; });
  }
  // Clear what the daemons noted while starting, so each wait below returns on what it heard.
  for (const s of seats) await request(runtimeOf(home, s.soul).socket, { op: 'read' });
});

after(async () => {
  for (const s of seats) await request(runtimeOf(home, s.soul).socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('C6 A2 A3: A says a sentence and B gets it with its words; a whisper from A to C never reaches B', async () => {
  // A2: a wake rule fires on what B hears (R9's matcher, the shared mechanism R13's wake rules use).
  const rule = { when: { event: 'souls:said' }, send: { verb: 'local:nod' }, expires: 60 };
  assert.equal((await request(runtimeOf(home, B).socket, { op: 'reflex', do: 'add', rule })).ok, true);

  // A3: A says; B's wait returns with the sentence, within the stream's lag.
  const said = 'the bread is still warm';
  const waitB = soulsLater(B, 'wait', '20');
  await sleep(300); // B's wait is waiting
  const t0 = performance.now();
  const say = souls(A, 'say', said);
  assert.equal(say.ok, true, JSON.stringify(say));
  const { answer: gotB, at } = await waitB;
  const lag = at - t0;
  const heardB = heardIn(gotB);
  assert.deepEqual(heardB.map((e) => [e.from, e.words, e.whisper]), [[body(0), said, false]], JSON.stringify(gotB));
  assert.ok(gotB.note, 'heard words are quoted as data');
  assert.ok(lag < LAG_MS, `B heard it ${Math.round(lag)} ms after it was said (bound ${LAG_MS} ms)`);
  assert.ok((gotB.changed.reflexes ?? []).some((f) => f.event === 'souls:said'), `B's reflex fired: ${JSON.stringify(gotB.changed)}`);
  if (process.env.C6_REPORT) console.log(`said -> B's wait: ${Math.round(lag)} ms`);

  // A whispers to C: C hears it with its words, B never does.
  const whispered = 'meet me by the lamp';
  const whisper = souls(A, 'whisper', body(2), whispered);
  assert.equal(whisper.ok, true, JSON.stringify(whisper));
  const heardC = [];
  await waitFor(async () => {
    heardC.push(...heardIn((await soulsLater(C, 'wait', '5')).answer));
    return heardC.some((e) => e.whisper);
  });
  assert.deepEqual(heardC.map((e) => [e.from, e.words, e.whisper]), [[body(0), said, false], [body(0), whispered, true]], JSON.stringify(heardC));

  // A2: A says again; B's next brief (look) shows what was said near it since its last turn, and not the whisper.
  const again = 'the lamp is lit';
  souls(A, 'say', again);
  await sleep(1000);
  const look = souls(B, 'look');
  assert.deepEqual(look.heard?.map((h) => h.words), [again], JSON.stringify(look));
  assert.ok(look.note, 'quoted as data');
  // Nothing B was given, by wait, look or read, ever holds the whisper.
  const rest = await request(runtimeOf(home, B).socket, { op: 'read' });
  for (const answer of [gotB, look, rest]) assert.ok(!JSON.stringify(answer).includes(whispered), `B never hears the whisper: ${JSON.stringify(answer)}`);
});
