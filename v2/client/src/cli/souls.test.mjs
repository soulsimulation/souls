// The thin command (Engine v2 R7, #2701) against the real gateway (`gatewayd`, I1) and the world's end of it
// (`worldd gateway-link`, I4's world of lamps) holding a hall of 1,000 items, with two Souls, each a body beside its
// lamp: the one the commands drive, and another whose acts change the world between them. Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// R7_REPORT=1 prints the timings and the brief's size, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { requestOf } from './souls.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, 'souls.mjs');
const CUPS = 1000, SEQUENCES = 100;
// `worldd gateway-link`'s world mints from scope 2b: the place, the room, each body and its lamp, then the items.
const WORLD_SCOPE = '2b'.repeat(16), BODIES = 2, FIRST_ITEM = 2 + 2 * BODIES, THINGS = CUPS + BODIES;
const LAMP_B = `${WORLD_SCOPE}-5`, LAMP_B_NAME = 'lamp 5';
const A = 's_r7me', B = 's_r7other';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-r7-'));
const home = join(dir, '.souls');
const procs = [];
const seat = (counter) => ({ grant: `soul-${WORLD_SCOPE}-${counter}`, token: `soul-${WORLD_SCOPE}-${counter}.${randomBytes(32).toString('hex')}` });
const a = seat(2), b = seat(4); // the world's two bodies
const times = { status: [], look: [], find: [], act: [], wait: [] };
let rtA, rtB;

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
    await sleep(10);
  }
}

/** The thin command, as a harness runs it: its whole run timed, its answer parsed. */
function souls(args, { soul = A, env = {}, node = [] } = {}) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [...node, CLI, ...args, '--soul', soul], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG, ...env }, encoding: 'utf8' });
  const ms = performance.now() - t0;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  times[args[0]]?.push(ms);
  return JSON.parse(r.stdout);
}

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, [a, b].map((s) => `${s.grant} ${createHash('sha256').update(s.token).digest('hex')}\n`).join(''));
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', String(BODIES), '--items', String(CUPS)], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const [, addr] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${addr}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [A]: { local: { token: a.token } }, [B]: { local: { token: b.token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  rtA = runtimeOf(home, A);
  rtB = runtimeOf(home, B);
  // The first command starts each daemon; both are current before the measures start.
  souls(['status']);
  souls(['status'], { soul: B });
  for (const rt of [rtA, rtB]) await waitFor(async () => { const s = await request(rt.socket, { op: 'status' }); return s.connected && !s.syncing; });
  times.status.length = 0;
});

after(async () => {
  for (const rt of [rtA, rtB]) await request(rt.socket, { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('the arguments make the daemon request: act takes a ranked list, find its words, wait its seconds', () => {
  assert.deepEqual(requestOf(['act', 'eden:sit', 'eden:lean', '--soul', 's_x']), { req: { op: 'act', acts: ['eden:sit', 'eden:lean'] }, soul: 's_x' });
  assert.deepEqual(requestOf(['find', 'the', 'red', 'cup', '--limit', '3']).req, { op: 'find', words: 'the red cup', limit: 3 });
  assert.deepEqual(requestOf(['wait', '5']).req, { op: 'wait', seconds: 5 });
  assert.equal(requestOf(['dance']).refused, 'unknown-command');
});

/**
 * What the world's log changed between two of its versions. Only the other Soul's acts change it, each one log entry
 * that switches its lamp (on, else off): the lamp differs when it was switched an odd number of times.
 */
function logChanged(from, to) {
  return (to - from) % 2 === 1 ? [LAMP_B_NAME] : [];
}

test('A2: over 100 scripted command sequences, each answer\'s "changed" equals the log\'s changes since the answer before', async () => {
  // The baseline: the first answer shows everything as new; every answer after it is checked against the log.
  let last = souls(['look']).at;
  let rng = 7;
  const next = (n) => { rng = (rng * 1103515245 + 12345) % 2 ** 31; return (rng >>> 12) % n; };
  let checked = 0;
  for (let k = 0; k < SEQUENCES; k++) {
    const steps = 1 + next(4);
    for (let j = 0; j < steps; j++) {
      // The other Soul acts between my commands, so not every change is mine.
      for (let m = next(3); m > 0; m--) await request(rtB.socket, { op: 'act', verbs: ['r2:switch_on', 'r2:switch_off'], target: LAMP_B });
      const pick = next(4);
      const answer = pick === 0 ? souls(['look']) : pick === 1 ? souls(['find', 'item', String(FIRST_ITEM + next(CUPS))]) : pick === 2 ? souls(['act', 'eden:sit', 'eden:lean']) : souls(['wait', '0']);
      assert.equal(answer.ok, true, JSON.stringify(answer));
      assert.ok(answer.at >= last, `at ${answer.at} after ${last}`);
      const want = logChanged(last, answer.at);
      assert.deepEqual(Object.keys(answer).at(-1), 'changed', 'every answer ends with what changed');
      assert.deepEqual(answer.changed.names, want.slice(0, 12), `between ${last} and ${answer.at}`);
      assert.equal(answer.changed.more ?? 0, Math.max(0, want.length - 12));
      last = answer.at;
      checked++;
    }
  }
  if (process.env.R7_REPORT) console.log(JSON.stringify({ sequences: SEQUENCES, answersChecked: checked, lastVersion: last }));
});

test('A1 (hall of 1,000), A4, A5: the brief is under 2,000 bytes, says what it left out, counts nothing beyond the room, names things', async () => {
  const look = souls(['look']);
  const bytes = Buffer.byteLength(JSON.stringify(look));
  assert.ok(bytes < 2000, `${bytes} bytes`);
  assert.equal(look.room.name, 'room 1');
  assert.ok(look.here.length > 20 && look.here.every((n) => /^item \d+$/.test(n)), 'things are named');
  assert.match(look.left[0], new RegExp(`^${THINGS - look.here.length} more things in room 1: find them by name$`));
  assert.deepEqual(look.outward, [{ name: 'place 0', kind: 'souls:place' }], 'the room\'s parent by name, no counts');
  const text = JSON.stringify(look);
  assert.ok(!/"(at|position|x|y|z|pose)":\s*\[/.test(text), 'no coordinates');
  // find: one search over the copy; an item beyond what the brief named is found by its name.
  const far = `item ${FIRST_ITEM + CUPS - 1}`;
  assert.ok(!look.here.includes(far));
  const found = souls(['find', far]);
  assert.deepEqual(found.found[0], { id: found.found[0].id, name: far, kind: 'souls:item', in: 'room 1, place 0' });
  assert.ok(!JSON.stringify(found).includes('"at":['), 'no coordinates');
  if (process.env.R7_REPORT) console.log(JSON.stringify({ hallBriefBytes: bytes, named: look.here.length }));
});

test('A3: the command loads no WASM, and its median time is under 100 ms', async () => {
  // It runs with WebAssembly gone: any module it loaded that compiled WASM would fail.
  const off = 'data:text/javascript,for (const k of Object.keys(WebAssembly)) delete WebAssembly[k]; globalThis.WebAssembly = undefined;';
  const s = souls(['look'], { node: ['--import', off] });
  assert.equal(s.ok, true);
  for (let k = 0; k < 20; k++) { souls(['status']); souls(['look']); souls(['find', 'item', String(k)]); }
  const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const report = Object.fromEntries(Object.entries(times).filter(([, xs]) => xs.length).map(([k, xs]) => [k, { n: xs.length, medianMs: Math.round(median(xs)) }]));
  if (process.env.R7_REPORT) console.log(JSON.stringify({ timings: report }));
  const all = Object.values(times).flat();
  assert.ok(median(all) < 100, `median ${Math.round(median(all))} ms over ${all.length} commands: ${JSON.stringify(report)}`);
});

test('the daemon\'s log and state hold no token', () => {
  for (const f of [rtA.log, rtA.state]) assert.ok(!readFileSync(f, 'utf8').includes(a.token.split('.')[1]));
});

test('C4: say, whisper and lie make their daemon requests', () => {
  assert.deepEqual(requestOf(['say', 'the', 'bread', 'is', 'warm']).req, { op: 'say', words: 'the bread is warm' });
  assert.deepEqual(requestOf(['whisper', LAMP_B, 'just', 'you']).req, { op: 'whisper', to: LAMP_B, words: 'just you' });
  assert.deepEqual(requestOf(['lie', LAMP_B]).req, { op: 'lie', this: LAMP_B });
});

/** Every file under `d`, as one buffer. */
const filesUnder = (d) => Buffer.concat(readdirSync(d, { recursive: true }).map((f) => join(d, f)).filter((f) => statSync(f).isFile()).map((f) => readFileSync(f)));

test('C4 A1: say and whisper send T8 words through the daemon; the world keeps them and answers with a receipt', async () => {
  const said = 'the bread is still warm', whispered = 'meet me by the lamp';
  const say = souls(['say', said]);
  const whisper = souls(['whisper', `${WORLD_SCOPE}-4`, whispered]); // the other Soul's body
  for (const [what, r] of [['say', say], ['whisper', whisper]]) {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sent, true, `${what} sent at once`);
    assert.equal(r.verb, `local:${what}`, 'a form verb in the world\'s namespace');
  }
  const got = [];
  await waitFor(async () => {
    got.push(...(await request(rtA.socket, { op: 'read' })).events.filter((e) => e.kind === 'answer'));
    return [say, whisper].every((r) => got.some((e) => e.sequence === r.sequence));
  });
  for (const r of [say, whisper]) assert.equal(got.find((e) => e.sequence === r.sequence).answer, 1, `a receipt: ${JSON.stringify(got)}`);
  // The words are in the world's text store (K16), and no byte of them is in its log (T8 rule 6).
  const store = filesUnder(join(dir, 'w.text')), log = readFileSync(join(dir, 'w.log'));
  for (const w of [said, whispered]) {
    assert.ok(store.includes(w), `"${w}" kept in the text store`);
    assert.ok(!log.includes(w), `"${w}" not in the log`);
  }
  // Refused by name before anything is sent: no words, a whisper to no one, a lie on nothing.
  const refused = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--soul', A], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8' });
    return JSON.parse(r.stdout).code;
  };
  assert.equal(refused(['say']), 'words-empty-or-long');
  assert.equal(refused(['whisper', 'bob', 'hi']), 'whisper-names-a-body');
  assert.equal(refused(['lie']), 'lie-names-a-thing');
});
