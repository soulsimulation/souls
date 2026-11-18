// An answer's age (Engine v2 R10, #2702), on a clock the test steps. The daemon gives it `performance.now()`; the
// cut-off against the real gateway is in daemon.test.mjs.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ASLEEP_AFTER_MS, FRESH_MS, ageOf } from './age.mjs';

test('A1: age is the steady time since the copy was confirmed, and a gap says since when and why', () => {
  const at = { startedAt: 0, confirmedAt: 1000, changedAt: 1000, cutAt: null, why: null };
  assert.deepEqual(ageOf({ ...at, now: 1500 }), { age: 500 });
  // Not yet confirmed: the age runs from the daemon's start, and the gap says it is not connected.
  assert.deepEqual(ageOf({ ...at, confirmedAt: null, changedAt: null, cutAt: 0, why: 'not-connected', now: 300 }),
    { age: 300, stale: true, gap: { ms: 300, why: 'not-connected' } });
  // Cut off at 4,000: the gap grows with the age.
  assert.deepEqual(ageOf({ ...at, cutAt: 4000, why: 'no-answer', now: 34_000 }),
    { age: 33_000, stale: true, gap: { ms: 30_000, why: 'no-answer' } });
  // An act's answer does not ask first: past FRESH_MS unconfirmed it is stale, though nothing was seen to fail.
  assert.deepEqual(ageOf({ ...at, now: 1000 + FRESH_MS, asked: false }), { age: FRESH_MS });
  assert.deepEqual(ageOf({ ...at, now: 1000 + FRESH_MS + 1, asked: false }),
    { age: FRESH_MS + 1, stale: true, gap: { ms: 1, why: 'unconfirmed' } });
});

test('A2: a world confirmed current that has written nothing is asleep, not stale', () => {
  const still = { startedAt: 0, changedAt: 1000, cutAt: null, why: null };
  // Confirmed just now, unchanged for ASLEEP_AFTER_MS: asleep since then, and not stale.
  const a = ageOf({ ...still, confirmedAt: 1000 + ASLEEP_AFTER_MS + 4000, now: 1000 + ASLEEP_AFTER_MS + 4100 });
  assert.deepEqual(a, { age: 100, asleep: { sinceMs: ASLEEP_AFTER_MS + 4100 } });
  // Cut off, the same world is stale: the client cannot know it still sleeps.
  const b = ageOf({ ...still, confirmedAt: 2000, cutAt: 3000, why: 'not-connected', now: 40_000 });
  assert.equal(b.stale, true);
  assert.equal(b.asleep, undefined);
});
