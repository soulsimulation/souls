// #2508: an act's parts inside the handler (bind, check, route) reach live.json's histograms when the act carries them, and
// since-start sums of every part and of admission's charge let a harness take means per act over its own window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {apiOf, newSharedApi, recordApi, recordCharge} from './load/api-times.ts';

test('#2508 act parts: bind, check and route beside handler, wait and commit; sums and the charge since start', () => {
  const a = newSharedApi(), now = 1_000_000;
  recordApi('edge:act', 5, 40, now, a, {handler: 30, wait: 4, commit: 6, bind: 20, check: 8, route: 3});
  recordApi('edge:act', 5, 20, now, a, {handler: 10, wait: 2, commit: 8});   // an act without the inner marks: as before
  recordApi('edge:here', 1, 2, now, a);
  recordCharge(28, a); recordCharge(12, a);
  const p = apiOf(a, now).routes['edge:act']!.parts!;
  assert.equal(p.handler.max, 30); assert.equal(p.bind!.max, 20); assert.equal(p.check!.max, 8); assert.equal(p.route!.max, 3);
  assert.deepEqual(p.sums, {n: 2, handler: 40, wait: 6, commit: 14, bind: 20, check: 8, route: 3, chargedN: 2, chargedMs: 40});
  assert.equal(apiOf(a, now).routes['edge:here']!.parts, undefined);
});
