import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapsFor, inMemoryFractions, memFigure, mulberry, pct, probeSource, PIECES, summarizeActs } from './plan.mjs';

test('the agents act at seeded gaps inside the window, the same every run', () => {
  const a = gapsFor(mulberry(7), 0, 3_600_000, 120_000, 600_000), b = gapsFor(mulberry(7), 0, 3_600_000, 120_000, 600_000);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 6 && a.length <= 30);
  a.forEach((t, i) => { const gap = t - (i ? a[i - 1] : 0); assert.ok(gap >= 119_999 && gap <= 600_001 && t < 3_600_000); });
});

test('the added wait is an act to an unloaded world less the median act to a world in memory', () => {
  const acts = [{ before: 'running', ok: true, ms: 100 }, { before: 'running', ok: true, ms: 120 }, { before: 'stopped', ok: true, ms: 2100 }, { before: 'stopped', ok: false, code: 'world.waking', ms: 45_000 }];
  const s = summarizeActs(acts, [{ inMem: 3, starting: 1, cpuCores: 0.5 }, { inMem: 5, starting: 2, cpuCores: 1 }]);
  assert.equal(s.warmActMs, 100); assert.deepEqual(s.addedWaitMs, { n: 2, p50: 2000, p95: 44_900, max: 44_900 });
  assert.equal(s.failed, 1); assert.equal(s.refused, 1); assert.deepEqual(s.codes, { 'world.waking': 1 });
  assert.equal(s.inMemMax, 5); assert.equal(s.startingMax, 2);
});

test('each world\'s fraction of the time in memory', () => {
  const f = inMemoryFractions([{ status: { a: 'running', b: 'stopped' } }, { status: { a: 'running', b: 'starting' } }, { status: { a: 'stopped', b: 'stopped' } }, { status: { a: 'running', b: 'stopped' } }]);
  assert.deepEqual(f.perWorld, { a: 0.75, b: 0.25 }); assert.equal(f.max, 0.75); assert.equal(f.p50, 0.25);
});

test('a piece the checkout lacks is named with its task; nothing is named when all are there', () => {
  assert.deepEqual(probeSource(() => true), []);
  const missing = probeSource((pattern) => pattern !== '__sim/still');
  assert.deepEqual(missing.map((m) => m.issue), ['#2297']);
  assert.equal(probeSource(() => false).length, PIECES.length);
});

test('figures', () => {
  assert.equal(memFigure(25), 6250);
  assert.deepEqual(pct([]), { n: 0, p50: null, p95: null, max: null });
  assert.deepEqual(pct([3, 1, 2]), { n: 3, p50: 2, p95: 3, max: 3 });
});
