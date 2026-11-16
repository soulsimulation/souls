// #2508: an act's parts inside the handler (bind, check, route) reach live.json's histograms when the act carries them, and
// since-start sums of every part and of admission's charge let a harness take means per act over its own window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {API_WINDOW_MS, apiOf, newSharedApi, recordApi, recordCharge} from './load/api-times.ts';
import {Admission} from './load/admission.ts';

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
  // the inner parts' windows rotate with the others (the sums do not)
  for (const t of [now + API_WINDOW_MS, now + 2 * API_WINDOW_MS]) recordApi('edge:act', 1, 5, t, a, {handler: 5, wait: 1, commit: 1, bind: 2, check: 1, route: 1});
  const q = apiOf(a, now + 2 * API_WINDOW_MS).routes['edge:act']!.parts!;
  assert.equal(q.handler.max, 5); assert.equal(q.bind!.max, 2); assert.equal(q.route!.max, 1); assert.equal(q.sums!.n, 4);
});

test('#2508 admission charges an act into its own world\'s numbers', async () => {
  const api = newSharedApi(), adm = new Admission({api});
  const t = adm.request({key: 's1', god: false, route: {cls: 'C1', id: 'edge:act', god: false, deadlineMs: 5000}});
  assert.ok('turn' in t); assert.equal(await t.turn, 'run'); t.done();
  recordApi('edge:act', 0, 1, Date.now(), api, {handler: 1, wait: 0, commit: 0});   // the answer, as the middleware records it
  assert.equal(apiOf(api).routes['edge:act']!.parts!.sums!.chargedN, 1);
});
