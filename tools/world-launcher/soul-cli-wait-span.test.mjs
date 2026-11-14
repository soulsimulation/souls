// #2292: `act --wait 76` returned at 60 s with a climb upstairs still `started`. A wait now holds as long as it is asked, up
// to WAIT_MAX_S, which covers long acts; a wait asked for more says it was capped and that the act is still running.
import test from 'node:test';
import assert from 'node:assert/strict';
import {WAIT_MAX_S, waitSpan, brief} from './soul/eden.mjs';

test('a wait holds as long as asked, up to WAIT_MAX_S; beyond it, capped', () => {
  assert.ok(WAIT_MAX_S >= 120, 'long acts (a climb upstairs, about 64 s) fit in one wait');
  assert.deepEqual(waitSpan(76), {seconds: 76});
  assert.deepEqual(waitSpan('76'), {seconds: 76});
  assert.deepEqual(waitSpan(undefined), {seconds: 45});
  assert.deepEqual(waitSpan(0), {seconds: 45});
  assert.deepEqual(waitSpan(WAIT_MAX_S), {seconds: WAIT_MAX_S});
  assert.deepEqual(waitSpan(WAIT_MAX_S + 1), {seconds: WAIT_MAX_S, capped: WAIT_MAX_S});
});

test('a capped wait says so beside the act still under way', () => {
  const o = brief({waited: '300s', waitCapped: '300s, the most a wait holds; wait again while done is false', receipt: {id: 'r_1', capability: 'walk:upstairs', phase: 'started'}});
  assert.equal(o.done, false);
  assert.match(o.waitCapped, /wait again while done is false/);
  assert.equal(brief({waited: '76s', receipt: {id: 'r_1', capability: 'walk:upstairs', phase: 'completed'}}).waitCapped, undefined);
});
