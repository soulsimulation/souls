// The new-engine observer's projections (0.135 P1). The stream itself is played by smoke.mjs on a running world.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { answersOf, finalBySequence, receiptReader } from './receipts.mjs';
import { clientKey, pageKey, streamUrl } from './stream.mjs';

test('the stream and the client name a body the same way', () => {
  assert.equal(pageKey('ab12-7'), 'ab12.7');
  assert.equal(clientKey('ab12.7'), 'ab12-7');
  assert.equal(clientKey(pageKey('00ff-123')), '00ff-123');
  assert.equal(streamUrl('http://127.0.0.1:7400/w/dev/', { stream: '/s/w/dev/abc' }), 'http://127.0.0.1:7400/s/w/dev/abc/');
  assert.equal(streamUrl('http://127.0.0.1:7400/w/dev/', { stream: 'views/stream/' }), 'http://127.0.0.1:7400/w/dev/views/stream/');
});

test("the gateway's answers become receipts, the last one per intent standing", () => {
  const reply = { ok: true, cursor: 9, events: [
    { n: 3, kind: 'answer', sequence: 1, answer: 3 },
    { n: 4, kind: 'heard', words: 'hi' },
    { n: 5, kind: 'answer', sequence: 1, answer: 1 },
    { n: 6, kind: 'answer', sequence: 2, answer: 2, reason: 'seat.taken' },
  ] };
  const r = answersOf(reply);
  assert.deepEqual(r.map((x) => x.outcome), ['accepted', 'receipt', 'refused']);
  const last = finalBySequence(r);
  assert.equal(last.get(1).outcome, 'receipt');
  assert.equal(last.get(2).reason, 'seat.taken');
});

test('a reader asks only for the events after its cursor', async () => {
  const asked = [];
  const seat = { events: async (since) => { asked.push(since); return since === 0 ? { ok: true, cursor: 5, events: [{ n: 5, kind: 'answer', sequence: 1, answer: 1 }] } : { ok: true, cursor: 5, events: [] }; } };
  const reader = receiptReader(seat);
  assert.equal((await reader.read()).length, 1);
  assert.equal((await reader.read()).length, 1);
  assert.deepEqual(asked, [0, 5]);
});
