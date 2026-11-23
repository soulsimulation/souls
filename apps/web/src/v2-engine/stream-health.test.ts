import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_NOTICE, streamNotice, type StreamHealth } from './stream-health.ts';

const base: StreamHealth = { failed: false, error: null, errorAtParts: null, parts: 0, startedAt: 1000, lastPartAt: null, now: 1000 };
const at = (h: Partial<StreamHealth>) => streamNotice({ ...base, ...h });

test('no part 15 s after the start is unavailable; before that it is only loading', () => {
  assert.equal(at({ now: 15_999 }), null);
  assert.equal(at({ now: 16_000 }), STREAM_NOTICE);
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
