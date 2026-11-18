// The thin command (Engine v2 R7, #2701) against the real gateway (`gatewayd`, I1) and the world's stand-in end of it
// (`worldd gateway-link`) holding a hall of 1,000 cups, with two Souls: the one the commands drive, and another whose
// acts change the world between them. Run from v2/ after
//   cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// R7_REPORT=1 prints the timings and the brief's size, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const A = 's_r7me', B = 's_r7other';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-r7-'));
const home = join(dir, '.souls');
const procs = [];
const seat = () => { const scope = randomBytes(16).toString('hex'); return { scope, token: `soul-${scope}-7.${randomBytes(32).toString('hex')}` }; };
const a = seat(), b = seat();
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
  writeFileSync(tokens, [a, b].map((s) => `soul-${s.scope}-7 ${createHash('sha256').update(s.token).digest('hex')}\n`).join(''));
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--room', String(CUPS)], { stdio: 'ignore' }));
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
  assert.deepEqual(requestOf(['act', 'eden:sit', 'eden:lean', '--soul', 's_x']), { req: { op: 'act', verbs: ['eden:sit', 'eden:lean'] }, soul: 's_x' });
  assert.deepEqual(requestOf(['find', 'the', 'red', 'cup', '--limit', '3']).req, { op: 'find', words: 'the red cup', limit: 3 });
  assert.deepEqual(requestOf(['wait', '5']).req, { op: 'wait', seconds: 5 });
  assert.equal(requestOf(['dance']).refused, 'unknown-command');
});

/** What the world's log changed between two of its versions: the stand-in sets cup `s % CUPS` at sequence `s`. */
function logChanged(from, to) {
  const names = new Set();
  for (let s = from + 1; s <= to; s++) names.add(`cup ${2 + (s % CUPS)}`);
  return [...names].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
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
      for (let m = next(3); m > 0; m--) await request(rtB.socket, { op: 'act', verbs: ['eden:wave'] });
      const pick = next(4);
      const answer = pick === 0 ? souls(['look']) : pick === 1 ? souls(['find', 'cup', String(2 + next(CUPS))]) : pick === 2 ? souls(['act', 'eden:sit', 'eden:lean']) : souls(['wait', '0']);
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
  assert.ok(look.here.length > 20 && look.here.every((n) => /^cup \d+$/.test(n)), 'things are named');
  assert.match(look.left[0], new RegExp(`^${CUPS - look.here.length} more things in room 1: find them by name$`));
  assert.deepEqual(look.outward, [{ name: 'place 0', kind: 'souls:place' }], 'the room\'s parent by name, no counts');
  const text = JSON.stringify(look);
  assert.ok(!/"(at|position|x|y|z|pose)":\s*\[/.test(text), 'no coordinates');
  // find: one search over the copy; a cup beyond what the brief named is found by its name.
  const far = `cup ${2 + CUPS - 1}`;
  assert.ok(!look.here.includes(far));
  const found = souls(['find', far]);
  assert.deepEqual(found.found[0], { id: found.found[0].id, name: far, kind: 'souls:cup', in: 'room 1, place 0' });
  assert.ok(!JSON.stringify(found).includes('"at":['), 'no coordinates');
  if (process.env.R7_REPORT) console.log(JSON.stringify({ hallBriefBytes: bytes, named: look.here.length }));
});

test('A3: the command loads no WASM, and its median time is under 100 ms', async () => {
  // It runs with WebAssembly gone: any module it loaded that compiled WASM would fail.
  const off = 'data:text/javascript,for (const k of Object.keys(WebAssembly)) delete WebAssembly[k]; globalThis.WebAssembly = undefined;';
  const s = souls(['look'], { node: ['--import', off] });
  assert.equal(s.ok, true);
  for (let k = 0; k < 20; k++) { souls(['status']); souls(['look']); souls(['find', 'cup', String(k)]); }
  const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const report = Object.fromEntries(Object.entries(times).filter(([, xs]) => xs.length).map(([k, xs]) => [k, { n: xs.length, medianMs: Math.round(median(xs)) }]));
  if (process.env.R7_REPORT) console.log(JSON.stringify({ timings: report }));
  const all = Object.values(times).flat();
  assert.ok(median(all) < 100, `median ${Math.round(median(all))} ms over ${all.length} commands: ${JSON.stringify(report)}`);
});

test('the daemon\'s log and state hold no token', () => {
  for (const f of [rtA.log, rtA.state]) assert.ok(!readFileSync(f, 'utf8').includes(a.token.split('.')[1]));
});
