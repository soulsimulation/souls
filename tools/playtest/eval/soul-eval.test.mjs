import test from 'node:test';
import assert from 'node:assert/strict';
import { unmeasured } from './soul-eval.mjs';

test('#2047: a run passes only when it measured; every episode or over 20% errored fails it', () => {
  const ok = { item: 'a', succeeded: false }, err = { item: 'b', error: 'the client keeps no world copy' };
  assert.equal(unmeasured([ok, ok, ok, ok, ok]), null);
  assert.equal(unmeasured([err, ok, ok, ok, ok]), null);   // 1 of 5: at the threshold, not over it
  assert.match(unmeasured([err, err, ok, ok, ok]), /2 of 5 episodes errored, over the declared 20%.*no world copy/);
  assert.match(unmeasured([err, err]), /measured nothing: all 2 episode\(s\) errored/);
  assert.match(unmeasured([]), /measured nothing: no episode ran/);
});
