import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverTiming, quantile, tickWindows, windowFigures } from './stats.mjs';

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
    { at: 1000, cpuS: 10, rssMb: 500, live: { tick: { service5s: 1 }, api: { ticks: tw(900, 0, 9) } } },
    { at: 11000, cpuS: 15, rssMb: 510, live: { tick: { service5s: 0.9 }, api: { ticks: tw(10_500, 0.5, 20) } } },
    { at: 21000, cpuS: 20, rssMb: 520, live: { tick: { service5s: 1 }, heap: { usedMb: 300 }, api: { ticks: tw(20_500, 0, 12) } } },
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
  assert.equal(w.viewersOut.bytesPerViewerPerS, 500);
  assert.equal(w.viewerCalls.worldCalls, 3);
  assert.deepEqual(w.viewerCalls.refusals, { 429: 1 });
});
