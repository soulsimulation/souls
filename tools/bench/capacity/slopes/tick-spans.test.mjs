// #1961: the world's tick span timers (world.ts tickSpans, SOULS_TICK_SPANS) and their summary (report.mjs). With the
// flag off nothing is written and the world is the same; with it on, one row per tick whose spans fit in the tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../../../apps/server/src/db.ts';
import { WorldHost } from '../../../../apps/server/src/world.ts';
import { factory } from '../../../../apps/server/test/native-owner-fixture.ts';   // the green-field engine
import { tickSpanTable, subtreeTop, walkerSlope } from './report.mjs';

function ticked(spans, n = 250) {
  if (spans) process.env.SOULS_TICK_SPANS = spans; else delete process.env.SOULS_TICK_SPANS;
  const db = new Db(':memory:'), host = new WorldHost(db, factory, 'tick-spans', 1e9, 'tick-spans', { durableClockV1: true });
  delete process.env.SOULS_TICK_SPANS;
  try { host.boot(); host.drainInputs(); for (let i = 0; i < n; i++) host.tickOnce(); return { on: !!host.tickSpans, seq: host.seq, tick: host.engine.world.tick, hash: host.engine.stateHash() }; }
  finally { host.stop(); db.close(); }
}

test('span timers: off by default and the same world either way; on, a row per tick every 100 ticks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tick-spans-')), file = join(dir, 'spans.jsonl');
  try {
    const off = ticked(null);
    assert.equal(off.on, false, 'off unless SOULS_TICK_SPANS is set');
    assert.equal(existsSync(file), false, 'off: nothing written');
    const on = ticked(file);
    assert.deepEqual({ ...on, on: false }, off, 'same seq, tick and state hash with the timers on');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 200, '250 ticks: two full batches of 100 written');
    for (const x of rows) { assert.equal(x.length, 8); assert.ok(x.slice(2, 7).reduce((a, b) => a + b, 0) <= x[1] + 0.01, 'the five spans fit in the tick'); }
    assert.deepEqual(rows.map((x) => x[0]), rows.map((_, i) => rows[0][0] + i), 'consecutive ticks');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tickSpanTable, subtreeTop and walkerSlope', () => {
  const rows = Array.from({ length: 100 }, (_, i) => [i + 1, i === 99 ? 20 : 10, 1, 5, 1, 1, 1, i === 50 ? 1 : 0]);
  const t = tickSpanTable(rows);
  assert.deepEqual({ p50: t.p50Ms, p99: t.p99Ms, snap: t.snapshotTicks }, { p50: 10, p99: 20, snap: [51] });
  assert.equal(Object.values(t.shares).reduce((a, b) => a + b, 0).toFixed(2), '1.00');
  const frame = (id, functionName, url, children = []) => ({ id, callFrame: { functionName, url, lineNumber: 0 }, children });
  const p = { nodes: [frame(1, '(root)', '', [2, 5]), frame(2, 'stepEngine', 'file:///r/apps/server/src/world.ts', [3, 4]), frame(3, 'navScan', 'file:///r/a.ts'), frame(4, 'solve', 'file:///r/b.ts'), frame(5, '(garbage collector)', '')],
    samples: [3, 3, 4, 5, 2], timeDeltas: [1000, 1000, 1000, 1000, 1000] };
  const s = subtreeTop(p, '/r');
  assert.deepEqual({ step: s.stepMs, gc: s.gcMs, top: s.top.map((x) => x.fn) }, { step: 4, gc: 1, top: ['navScan a.ts:1', 'solve b.ts:1', 'stepEngine apps/server/src/world.ts:1'] });
  const arm = (n, meanMs) => ({ arm: { walkers: n }, ticks: { meanMs } });
  assert.deepEqual(walkerSlope([arm(25, 12.5), arm(50, 15), arm(100, 20)]), { msPerWalker: 0.1, first: 0.1, second: 0.1, straight: true });
  assert.equal(walkerSlope([arm(25, 12.5), arm(50, 15), arm(100, 30)]).straight, false);
});
