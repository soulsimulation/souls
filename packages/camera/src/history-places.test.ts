// 0.135 P3a: people from a new-engine world's history, as places at moments, in the planner's `History`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyOfPlaces } from './history.ts';

test('places become a history in take ticks: interpolated, facing the way the body moved, absent before its first', () => {
  const T0 = 1_000_000_000;
  const h = historyOfPlaces([
    { id: 'a.0', at: T0 + 2_000_000, p: [10, 0, 0] }, { id: 'a.0', at: T0, p: [0, 0, 0] },
    { id: 'b.2', at: T0 + 1_000_000, p: [5, 1, 5] },
  ], { fromUs: T0, toUs: T0 + 4_000_000 });
  assert.equal(h.dt, 0.05); assert.equal(h.fromTick, T0 / 50_000); assert.equal(h.toTick, (T0 + 4_000_000) / 50_000);
  assert.deepEqual(h.ids, ['a.0', 'b.2']);
  const at = h.sampler();
  assert.deepEqual(at(1)['a.0'].p, [5, 0, 0], 'half way at half time');
  assert.ok(Math.abs(at(1.5)['a.0'].yaw) < 1e-9, 'walking +x: yaw 0, as the moves read it (forward = cos, sin)');
  assert.equal(at(0.5)['b.2'], undefined, 'not yet there');
  assert.deepEqual(at(3)['b.2'].p, [5, 1, 5], 'the last place held');
  assert.equal(h.riding('a.0', h.fromTick), null);
  assert.throws(() => historyOfPlaces([], { fromUs: 5, toUs: 5 }), /history-empty/);
});
