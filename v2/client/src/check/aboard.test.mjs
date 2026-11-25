// node --test v2/client/src/check/aboard.test.mjs
// First-day round 4: aboard a balloon, the answer says when it takes off, and a refusal when the Soul can get off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aboardOf, aboardWords, encodeCourse } from './aboard.mjs';
import { decode } from '../brief/copy.mjs';

const S = 1_000_000;
// A balloon's loop: 60 s at its stop (0, 0, 0), then 120 s aloft, then back; world time 0 is a landing.
const course = new Map([[1, [[[0, 0, 0], 60 * S], [[0, 30_000_000, -150_000_000], 0]]], [2, 1], [3, 3_000_000], [4, 0], [5, 120 * S]]);
const courseAt = (field, t) => {
  assert.deepEqual(decode(field), course, 'the course is read from its own canonical bytes');
  const k = Number(t) % (180 * S);
  return k < 60 * S ? [0n, 0n, 0n, 0n, 0n, 0n] : [0n, 30_000_000n, BigInt(-k), 0n, 0n, -3_000_000n];
};
const rows = () => {
  const balloon = { id: 'b-1', name: 'eden-balloon', kind: 'eden:launch_balloon', moving: true };
  Object.defineProperty(balloon, 'course', { value: course });
  return new Map([['b-1', balloon], ['w-0', { id: 'w-0', name: 'Wren', soul: 'me', parent: 'b-1' }]]);
};

test('at its stop: aboard, and when it takes off; a refusal says rise to get off', () => {
  const a = aboardOf({ rows: rows(), me: 'me', courseAt, now: 18 * S });
  assert.deepEqual(a, { id: 'b-1', name: 'eden-balloon', atStop: true, takesOffInS: 42 });
  assert.equal(aboardWords(a), 'aboard eden-balloon; takes off in 42 s');
  assert.equal(aboardWords(a, { refused: true }), 'aboard eden-balloon, at its stop: rise to get off (it takes off in 42 s)');
});

test('under way: a refusal says when it is back at its stop, where rise gets off', () => {
  const a = aboardOf({ rows: rows(), me: 'me', courseAt, now: 100 * S });
  assert.deepEqual(a, { id: 'b-1', name: 'eden-balloon', atStop: false, backInS: 80 });
  assert.equal(aboardWords(a, { refused: true }), 'aboard eden-balloon; you can get off at its stop in 80 s (rise then)');
});

test('not aboard a thing on a course: nothing is said', () => {
  const r = rows();
  r.get('w-0').parent = null;
  assert.equal(aboardOf({ rows: r, me: 'me', courseAt, now: 0 }), null);
  assert.equal(aboardWords(null), null);
});

test('the course goes back to the bytes the record holds, big and negative numbers too', () => {
  const v = new Map([[1, [[[-5, 2 ** 40, 7], 0]]], [4, 1_795_614_752_869_000n]]);
  assert.deepEqual(decode(encodeCourse(v)), new Map([[1, [[[-5, 2 ** 40, 7], 0]]], [4, 1_795_614_752_869_000]]));
});
