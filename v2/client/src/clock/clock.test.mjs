// Every copy knows what world time it is (Engine v2 E7b, #3516). A Soul's daemon on the real gateway (`gatewayd`, I1)
// and a real world (`worldd serve`, C1, on N2's test world) computes world now from its copy's root fields alone, and
// it is within one tick (50 ms) of the world's own clock, the mapping its ticker runs (printed at each start): at a
// first start (rate 1), after a restart at rate 2 (a new mapping, continuous with the last) and after a plain restart
// (the same mapping kept). Run from v2/ after
//   cargo build -p gatewayd -p worldd -p testworld --locked, and replica's wasm-bindgen package in target/wasm-load/pkg.
// E7B_REPORT=1 prints each check, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { clockOfFields, worldNow } from './clock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const bin = (name) => process.env[name.toUpperCase()] ?? join(v2, 'target/debug', name);
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, '../cli/souls.mjs');
const SOUL = 's_e7b';
const TICK_US = 50_000;
const report = (...a) => { if (process.env.E7B_REPORT) console.log(...a); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'souls-e7b-'));
const home = join(dir, '.souls'), world = join(dir, 'w'), socket = join(dir, 'w.sock');
const env = { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG };
const procs = [];

async function waitFor(f, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await f(); } catch { /* not listening yet */ }
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(50);
  }
}

/** A process, and the first match of `ready` on its output, the output so far kept. */
function run(path, args, ready) {
  const p = spawn(path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  const matched = new Promise((ok, fail) => {
    const on = (d) => { out += d; const m = ready.exec(out); if (m) ok(m); };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    p.on('exit', (c) => fail(new Error(`${path} ended (${c}): ${out}`)));
  });
  return { p, matched, out: () => out };
}

/** `worldd serve` at `rate`, and the mapping its ticker runs, as it prints it. */
async function serve(rate) {
  const w = run(bin('worldd'), ['serve', '--dir', world, '--socket', socket, '--rate', rate], /worldd: clock world (-?\d+) real (-?\d+) rate (\d+)\/(\d+)\n/);
  const [, wu, ru, num, den] = await w.matched;
  await waitFor(() => /listening /.test(w.out()));
  return { p: w.p, mapping: { world: Number(wu), real: Number(ru), rate: [Number(num), Number(den)] } };
}

function kill(p) {
  p.kill('SIGKILL');
  return new Promise((ok) => (p.exitCode !== null ? ok() : p.on('exit', ok)));
}

const daemon = () => runtimeOf(home, SOUL).socket;

/**
 * The daemon's world now against the world's own clock: the copy brought current (a look), then status; its clock is
 * the mapping the world runs, and its world now lies within one tick of the world's for the real times around it.
 */
async function check(mapping, what) {
  await request(daemon(), { op: 'look' });
  const t0 = Date.now() * 1000;
  const s = await request(daemon(), { op: 'status' });
  const t1 = Date.now() * 1000;
  const lo = worldNow(mapping, t0), hi = worldNow(mapping, t1);
  report(`${what}: clock ${JSON.stringify(s.clock)}, world now ${s.worldUs} in [${lo}, ${hi}] (${t1 - t0} µs around it)`);
  assert.deepEqual(s.clock, mapping, `${what}: the copy's clock is the world's`);
  assert.ok(s.worldUs >= lo - TICK_US && s.worldUs <= hi + TICK_US, `${what}: ${s.worldUs} not within a tick of [${lo}, ${hi}]`);
  return s;
}

after(async () => {
  await request(daemon(), { op: 'stop' }).catch(() => {});
  for (const p of procs) p.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

test('E7b A2: a copy computes world now within one tick, across a rate change and a restart', { timeout: 120_000 }, async () => {
  const tw = spawnSync(bin('testworld'), ['--out', join(dir, 'tw')], { encoding: 'utf8' });
  assert.equal(tw.status, 0, tw.stderr);
  const seeded = spawnSync(bin('worldd'), ['seed', '--facts', join(dir, 'tw', 'testworld-s1-t0.facts.json'), '--dir', world, '--souls', '1'], { encoding: 'utf8' });
  assert.equal(seeded.status, 0, seeded.stderr);
  const token = readFileSync(join(world, 'souls.tokens'), 'utf8').trim().split('\n')[0];

  let w = await serve('1/1');
  assert.deepEqual(w.mapping, { world: 0, real: 0, rate: [1, 1] }, 'a first start: world time is real time');
  const gw = run(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', socket, '--tokens', join(world, 'tokens'), '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const [, addr] = await gw.matched;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway: `ws://${addr}/v2/ws` } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [SOUL]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  const started = spawnSync(process.execPath, [CLI, 'status', '--soul', SOUL], { env, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  await waitFor(async () => { const s = await request(daemon(), { op: 'status' }); return s.connected && !s.syncing; });

  const first = await check(w.mapping, 'first start, rate 1');
  assert.ok(Math.abs(first.worldUs - Date.now() * 1000) < 1_000_000, 'world time is real time at rate 1');

  // A restart at rate 2: a new mapping applies, on the last one's line; the copy reads it once current again.
  await kill(w.p);
  await sleep(500);
  w = await serve('2/1');
  assert.deepEqual(w.mapping.rate, [2, 1]);
  assert.equal(w.mapping.world, w.mapping.real, 'continuous with world time = real time');
  await waitFor(async () => {
    await request(daemon(), { op: 'look' });
    return (await request(daemon(), { op: 'status' })).clock?.rate[0] === 2;
  });
  const a = await check(w.mapping, 'restart at rate 2');
  await sleep(1000);
  const b = await check(w.mapping, 'a second later');
  report(`rate: ${b.worldUs - a.worldUs} world µs over about a second`);
  assert.ok(b.worldUs - a.worldUs > 1_800_000, 'world time runs at twice real time');

  // A plain restart: the mapping in force is kept, and the copy's clock with it.
  const kept = w.mapping;
  await kill(w.p);
  await sleep(500);
  w = await serve('2/1');
  assert.deepEqual(w.mapping, kept, 'the same mapping after a restart at the same rate');
  await waitFor(async () => (await request(daemon(), { op: 'status' })).connected);
  await check(w.mapping, 'plain restart');
});

test('E7b: world now from the fields, rounded down on the line', () => {
  const fields = new Map([[66, 100], [67, 1_000], [68, [3, 2]]]);
  const c = clockOfFields(fields);
  assert.deepEqual(c, { world: 100, real: 1_000, rate: [3, 2] });
  assert.equal(worldNow(c, 1_001), 101); // 1.5 rounded down
  assert.equal(worldNow(c, 999), 98); // −1.5 rounded down
  assert.equal(clockOfFields(new Map([[66, 0], [67, 0]])), null, 'no rate, no clock');
});
