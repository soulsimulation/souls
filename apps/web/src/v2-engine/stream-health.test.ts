import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_CATCHING, STREAM_NOTICE, streamNotice, type StreamHealth } from './stream-health.ts';

const base: StreamHealth = { failed: false, error: null, errorAtParts: null, parts: 0, startedAt: 1000, lastPartAt: null, now: 1000 };
const at = (h: Partial<StreamHealth>) => streamNotice({ ...base, ...h });

test('no part 15 s after the start is unavailable; before that it is only loading', () => {
  assert.equal(at({ now: 15_999 }), null);
  assert.equal(at({ now: 16_000 }), STREAM_NOTICE);
});
test('#4684: a reader catching up says so while its words keep coming, and the notice only if they stop for 15 s', () => {
  assert.equal(at({ parts: 40, lastPartAt: 30_000, now: 31_000, catching: true }), STREAM_CATCHING);
  assert.equal(at({ parts: 40, lastPartAt: 30_000, now: 45_000, catching: true }), STREAM_NOTICE);
  assert.equal(at({ parts: 41, lastPartAt: 46_000, now: 46_100, catching: false }), null);
});
test('a failed import or start, or a reader error, is unavailable at once', () => {
  assert.equal(at({ failed: true }), STREAM_NOTICE);
  assert.equal(at({ error: 'boom', errorAtParts: 0 }), STREAM_NOTICE);
  assert.equal(at({ error: 'built without the v2 replica', errorAtParts: 0, parts: 0 }), STREAM_NOTICE);
});
test('a live stream that goes silent for 15 s shows the notice, and parts resuming clear it', () => {
  const live = { parts: 40, lastPartAt: 5000 };
  assert.equal(at({ ...live, now: 19_000 }), null);
  assert.equal(at({ ...live, now: 20_000 }), STREAM_NOTICE);
  assert.equal(at({ parts: 41, lastPartAt: 20_100, now: 20_200 }), null);
});
test('an error is cleared by a part that arrives after it', () => {
  assert.equal(at({ error: 'x', errorAtParts: 40, parts: 40, lastPartAt: 5000, now: 6000 }), STREAM_NOTICE);
  assert.equal(at({ error: 'x', errorAtParts: 40, parts: 41, lastPartAt: 6000, now: 6100 }), null);
});
test('25 Nov: an error in a still world is cleared once its pointer moves on, with no part (Eden showed the notice for 10 minutes)', () => {
  // A pointer read that failed once at 6 s; the world writes no part, but its quiet time moves on at 6.25 s.
  const still = { error: 'TypeError: Failed to fetch', errorAtParts: 40, errorAt: 6000, parts: 40 };
  assert.equal(at({ ...still, lastPartAt: 5900, now: 6100 }), STREAM_NOTICE, 'nothing since the error');
  assert.equal(at({ ...still, lastPartAt: 6250, now: 6300 }), null, 'the pointer moved on after it');
  assert.equal(at({ ...still, lastPartAt: 6250, now: 21_250 }), STREAM_NOTICE, 'and silence still shows after 15 s');
});
