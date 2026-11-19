// W3 (#2799): a click keeps one key until its answer (A4), and a limit's refusal names the limit and when to retry (A5).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClickKey, refusalText } from './worlds.ts';

test('a click keeps its key until it is answered', () => {
  let n = 0;
  const key = new ClickKey(() => `k${++n}`);
  assert.equal(key.take(), 'k1');
  assert.equal(key.take(), 'k1', 'a retry of an unanswered click sends the same key');
  key.answered();
  assert.equal(key.take(), 'k2', 'the next click is a new world');
});

test('a limit refusal names the limit and when to retry', () => {
  assert.equal(
    refusalText(429, { refused: 'world-limit-hourly', limit: "one world an hour in an account's first day", retry_after: 3540 }),
    "Refused: the limit is one world an hour in an account's first day. Try again in 59 min.",
  );
  assert.equal(
    refusalText(429, { refused: 'world-limit', limit: '5 worlds an account', retry_after: null }),
    'Refused: the limit is 5 worlds an account. It does not lift with time.',
  );
  assert.equal(refusalText(409, { refused: 'name-taken', detail: 'mine' }), 'Refused: name-taken (mine)');
});
