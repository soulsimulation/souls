import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serverTiming, quantile, tickWindows, windowFigures, reconnectDelayMs, seeded, stayMs, parseBurst, takesChunks, firstMotion } from './stats.mjs';

test('Server-Timing parts with a duration', () => {
  assert.deepEqual(serverTiming('world;dur=3.5, queue;dur=0.5, launcher;desc=cache'), { world: 3.5, queue: 0.5 });
  assert.deepEqual(serverTiming(null), {});
});

test('nearest-rank quantiles skip non-numbers', () => {
  assert.equal(quantile([3, 1, 2, NaN, undefined], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.95), 4);
  assert.equal(quantile([], 0.5), null);
});

test('tick windows inside the window, each once', () => {
  const t = (at) => ({ live: { api: { ticks: { at } } } });
  assert.equal(tickWindows([t(5), t(10), t(10), t(25)], 5, 20).length, 1);
});

test('one window: ticks, amber, acts, CPU, viewer bytes and world calls', () => {
  const tw = (at, amber, p99) => ({ at, tickMs: { p50: 4, p99 }, levels: { green: 1 - amber, amber, red: 0, black: 0 }, amberS: { service: 10 * amber, loop: 0, heap: 0, dwell: 1 } });
  const samples = [
    { at: 1000, cpuS: 10, rssMb: 500, launcherCpuS: 2, launcherRssMb: 100, driverCpuS: 1, live: { tick: { service5s: 1 }, api: { ticks: tw(900, 0, 9) } } },
    { at: 11000, cpuS: 15, rssMb: 510, live: { tick: { service5s: 0.9 }, api: { ticks: tw(10_500, 0.5, 20) } } },
    { at: 21000, cpuS: 20, rssMb: 520, launcherCpuS: 6, launcherRssMb: 140, driverCpuS: 21, live: { tick: { service5s: 1 }, heap: { usedMb: 300 }, api: { ticks: tw(20_500, 0, 12) } } },
  ];
  const acts = [
    { at: 2000, status: 200, accepted: true, queueMs: 1, worldMs: 5, clientMs: 8 },
    { at: 3000, status: 200, accepted: true, queueMs: 3, worldMs: 6, clientMs: 9 },
    { at: 4000, status: 429, code: 'rate-limited' },
    { at: 50_000, status: 200, accepted: true, queueMs: 99, worldMs: 100 },
  ];
  const calls = [{ status: 200, cache: 'miss' }, { status: 200, cache: 'hit' }, { status: 200, cache: 'shared' }, { status: 200, cache: null }, { status: 429, cache: null }];
  const w = windowFigures({ samples, acts, v0: { bytes: 0, messages: 0, opens: 0, closes: 0, refused: 0 }, v1: { bytes: 20_000, messages: 40, opens: 2, closes: 0, refused: 1 }, viewers: 2, calls, from: 1000, to: 21000 });
  assert.equal(w.tickWindows, 2);
  assert.deepEqual(w.tickMs, { p50: 4, p99: 20 });
  assert.deepEqual(w.levels, { amber: 0.25, red: 0, black: 0 });
  assert.deepEqual(w.amberS, { service: 5, loop: 0, heap: 0, dwell: 2 });
  assert.equal(w.tickService.min, 0.9);
  assert.deepEqual(w.acts.queueMs, { p50: 1, p95: 3 });
  assert.deepEqual(w.acts.handlerMs, { p50: 3, p99: 4 });
  assert.deepEqual(w.acts.refused, { '429 rate-limited': 1 });
  assert.equal(w.world.cpuShare, 0.5);
  assert.equal(w.world.rssMb, 520);
  assert.deepEqual(w.launcher, { cpuShare: 0.2, rssMb: 140 });
  assert.deepEqual(w.driver, { cpuShare: 1 });
  assert.equal(w.viewersOut.bytesPerViewerPerS, 500);
  assert.equal(w.viewerCalls.worldCalls, 3);
  assert.deepEqual(w.viewerCalls.refusals, { 429: 1 });
});

test('#2511 reconnect: the product client\'s backoff, and its source still says the same', () => {
  const lo = () => 0, hi = () => 0.999999;
  assert.equal(reconnectDelayMs(0, 1006, lo), 250);
  assert.ok(Math.abs(reconnectDelayMs(0, 1006, hi) - 500) < 0.01);
  assert.equal(reconnectDelayMs(3, 1006, lo), 2000);
  assert.equal(reconnectDelayMs(10, 1006, lo), 15_000);                 // the 30 s cap, lower half
  assert.equal(reconnectDelayMs(0, 1013, lo), 5000);                    // "try later": at least 5 s
  assert.equal(reconnectDelayMs(0, 1001, lo), 50);                      // a restart, first try
  assert.equal(reconnectDelayMs(1, 1001, lo), 500);                     // a restart again: the backoff
  const src = readFileSync(new URL('../../../../packages/client/src/index.ts', import.meta.url), 'utf8');
  for (const s of ['const restarting = ev?.code === 1001 && this.retry === 0;', 'Math.min(30_000, 500 * 2 ** this.retry)', 'Math.max(ev?.code === 1013 ? 5_000 : 0, window * (0.5 + 0.5 * Math.random()))', 'restarting ? 50 + 100 * Math.random() : backoffMs'])
    assert.ok(src.includes(s), `packages/client no longer says ${s}: update reconnectDelayMs`);
});

test('#2511 stays: seeded, heavy-tailed, the median as given', () => {
  const r = seeded(7), xs = Array.from({ length: 4000 }, () => stayMs(60, r)).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[2000] / 1000 - 60) < 6, `median ${xs[2000]}`);
  assert.ok(xs[3900] / 1000 > 300, 'a long tail');
  assert.deepEqual([seeded(3)(), seeded(3)()], [seeded(3)(), seeded(3)()]);
  assert.deepEqual(parseBurst('300@40'), { n: 300, atS: 40 });
  assert.equal(parseBurst(undefined), null);
  assert.throws(() => parseBurst('300'), /expected/);
});

test('#2511 first motion: a take with a chunk, read from the head of the message', () => {
  assert.equal(takesChunks('{"t":"take-chunks","contract":"take-chunk-ref/1","ids":[4,null],"same":[null,null],"payload":{}}'), 2);
  assert.equal(takesChunks('{"t":"take-chunks","contract":"take-chunk-ref/1","ids":[],"same":[],"payload":{}}'), 0);
  assert.equal(takesChunks('{"t":"take-entities","contract":"take-entities-ref/1","ids":[9],"payload":{}}'), 1);
  assert.equal(takesChunks('{"t":"takes","serverTick":12,"chunks":[]}'), 0);
  assert.equal(takesChunks('{"t":"takes","serverTick":12,"chunks":[{"take":{}}]}'), 1);
  assert.equal(takesChunks('{"t":"batch","seq":1}'), null);
  assert.equal(takesChunks(Buffer.from('x')), null);
  const m = [{ at: 100, ms: 1000 }, { at: 200, ms: 3000 }, { at: 300, ms: null }, { at: 9_000_000, ms: 1 }];
  assert.deepEqual(firstMotion(m, [], 0, 10_000), { n: 2, missed: 1, p50S: 3, p95S: 'none' });
  assert.deepEqual(firstMotion(m.slice(0, 2), [{ at: 9000 }], 0, 10_000), { n: 2, missed: 0, p50S: 1, p95S: 3 });   // waiting under 5 s: not yet a miss
  assert.deepEqual(firstMotion([], [], 0, 10_000), { n: 0, missed: 0, p50S: null, p95S: null });
  assert.equal(firstMotion([{ at: 1, ms: 7770 }], [], 0, 10).p50S, 7.77);   // no float tail (run 43826328779 printed 7.7700000000000005)
});

test('#2511 one window: viewers held, churn, acts against intended, heap', () => {
  const samples = [1000, 11_000, 21_000].map((at, i) => ({ at, cpuS: i, viewersLive: [190, 200, 210][i], live: { heap: { usedMb: [80, 120, 90][i] } } }));
  const c = (j, l, r) => ({ bytes: 0, messages: 0, opens: 0, closes: 0, refused: 0, joins: j, leaves: l, reconnects: r });
  const acts = Array.from({ length: 30 }, (_, i) => ({ at: 1000 + i * 600, status: 200, accepted: true }));
  const w = windowFigures({ samples, acts, v0: c(200, 0, 1), v1: c(260, 60, 4), viewers: 200, calls: [], from: 1000, to: 21_000, souls: 24, actSec: 10 });
  assert.deepEqual(w.held, { min: 190, mean: 200, max: 210 });
  assert.deepEqual(w.churn, { joinsPerS: 3, leavesPerS: 3, reconnects: 3 });
  assert.deepEqual(w.actsAchieved, { ok: 30, intended: 48, share: 0.625 });
  assert.equal(w.heapMaxMb, 120);
  assert.equal(w.world.heapUsedMb, 90);
  const zero = windowFigures({ samples: samples.map((s) => ({ ...s, viewersLive: 0 })), acts: [], v0: c(0, 0, 0), v1: c(0, 0, 0), viewers: 0, calls: [], from: 1000, to: 21_000 });
  assert.equal(zero.viewersOut.bytesPerViewerPerS, null);
  assert.equal(zero.actsAchieved.intended, null);
  // the world restarted inside the window (runs 43826332638, 43826345411): no CPU share across two processes
  const again = windowFigures({ samples: samples.map((s, i) => ({ ...s, pid: i < 2 ? 10 : 11, cpuS: [50, 60, 1][i] })), acts: [], v0: c(0, 0, 0), v1: c(0, 0, 0), viewers: 200, calls: [], from: 1000, to: 21_000 });
  assert.deepEqual([again.world.cpuShare, again.world.restarted], [null, true]);
  assert.equal(w.world.restarted, false);
});
