// #1750 A6: admission charges a request the time its handler holds the thread, not the time it spends awaiting the
// world's sequencer (an act's host.enqueue resolves only at the next tick). Before this, an act's estimate learned the
// tick wait (~100 ms for ~30 ms of work), and at 24 Souls each Soul's bucket (~21 ms/s) admitted one act per ~5 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {Admission, admissionMiddleware} from './load/admission.ts';
import {sequencerWait} from './load/wait-mark.ts';

const hold = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* work */ } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

test('an act with 15 ms of work and a 60 ms wait on the sequencer is charged ~15 ms; its estimate converges to ~15 ms', async () => {
  const adm = new Admission(), app = new Hono();
  app.use('*', admissionMiddleware(adm, () => 'green', c => c.req.header('authorization')?.slice(7)));
  // the handler's shape: read the body, plan (work), then await the sequencer (the next tick)
  app.post('/v1/edge/act', async c => { await c.req.text(); hold(15); await sequencerWait(sleep(60)); return c.json({accepted: true}); });
  // alone (the fast path) and in a crowd (the dispatcher's queue)
  for (let i = 0; i < 6; i++) await app.request('/v1/edge/act', {method: 'POST', headers: {authorization: `Bearer sim_a${i}`}, body: '{}'});
  const alone = adm.estimate('edge:act');   // before #1750 A6: 51.8 ms here (the 60 ms wait on the tick counted as work)
  assert.ok(alone >= 12 && alone <= 30, `alone, the act estimate is ${alone.toFixed(1)} ms`);
  await Promise.all(Array.from({length: 12}, (_, i) => app.request('/v1/edge/act', {method: 'POST', headers: {authorization: `Bearer sim_b${i}`}, body: '{}'})));
  const est = adm.estimate('edge:act');
  assert.ok(est >= 12 && est <= 30, `the act estimate is ${est.toFixed(1)} ms: the work, not the wait on the tick`);
  assert.ok(adm.spentMs >= 18 * 12 && adm.spentMs <= 18 * 35, `request time charged ${adm.spentMs.toFixed(0)} ms for 18 acts of 15 ms`);
  adm.close();
});

test('a handler that awaits nothing on the sequencer is charged as before (its whole time)', async () => {
  const adm = new Admission(), app = new Hono();
  app.use('*', admissionMiddleware(adm, () => 'green', c => c.req.header('authorization')?.slice(7)));
  app.get('/v1/edge/here', async c => { hold(20); await sleep(10); return c.json({here: 1}); });
  for (let i = 0; i < 4; i++) await app.request('/v1/edge/here', {headers: {authorization: `Bearer sim_h${i}`}});
  const est = adm.estimate('edge:here');
  assert.ok(est >= 25, `an ordinary await still counts (est ${est.toFixed(1)} ms)`);
  adm.close();
});
