// #3695: a creator's strike is drawn once, when the page's world time reaches it, and only while it is fresh.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRESH_US, due } from './lightning.ts';
import { F, readSky } from './record.ts';

test('a strike is drawn once, at its world time, and not when it is stale on arrival', () => {
  const s: [number, number, number] = [12_000, -4_000, 50_000_000];
  assert.deepEqual(due(s, 49_000_000, null), { fire: false, seen: null }, 'before its time: not yet');
  const first = due(s, 50_200_000, null);
  assert.deepEqual(first, { fire: true, seen: '12000,-4000,50000000' });
  assert.equal(due(s, 50_300_000, first.seen).fire, false, 'once');
  assert.deepEqual(due(s, 50_000_000 + FRESH_US + 1, null), { fire: false, seen: '12000,-4000,50000000' }, 'stale on arrival');
  assert.equal(due([0, 0, 60_000_000], 60_000_000, first.seen).fire, true, 'a new strike');
  assert.equal(due(null, 1, null).fire, false);
  assert.equal(due(s, null, null).fire, false);
});

test('the record reads the strike and the sky settings at their own field numbers, apart from the clock (66 to 68)', () => {
  const r = readSky({ [F.dayS]: 86_400, [F.origin]: 0, [F.offsets]: [[0, 0]], [F.strike]: [1, 2, 3], [F.palette]: 'souls:mars-desert', 66: 5, 67: 7, 68: [1, 1] });
  assert.deepEqual(r?.strike, [1, 2, 3]);
  assert.equal(r?.palette, 'souls:mars-desert', 'the clock\'s 67 is not the palette');
  assert.equal(r?.skyDate, null);
  assert.deepEqual(readSky({ [F.dayS]: 86_400, [F.origin]: 0, [F.offsets]: [[0, 0]], [F.strike]: [1, 'x', 3] })?.strike, null);
});
