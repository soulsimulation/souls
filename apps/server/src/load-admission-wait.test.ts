// #2124: an act is not held in admission for seconds behind other Souls' short acts. Two causes, measured on #2124: the fast
// path charged a lone act its whole life (its wait for the tick and its commit, when the thread is free for others), and the
// frame budget was calibrated from a quiet tick learned during setup, heavier than the tick the world pays under load.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Admission, classify, frameBudgetMs, type Ticket} from './load/admission.ts';
import {QuietTick} from './load/monitor.ts';

const act = classify('POST', '/v1/edge/act')!;
const tick = () => new Promise(r => setTimeout(r, 2));

test('two Souls\' short acts: the second is not held behind the first beyond one handler\'s time', async () => {
  let now = 1000;
  const yields: (() => void)[] = [];
  // the act's turn ends at its first yield (here: by hand, when its handler has run), as the dispatcher's setImmediate does
  const adm = new Admission({now: () => now, yieldTurn: () => new Promise<void>(r => { yields.push(r); }), quietTickMs: () => 12});
  adm.setLoadLevel('amber');
  const HANDLER = 20, WAIT_AND_COMMIT = 60;
  // Soul A acts alone: its handler takes 20 ms of the thread, then it waits for the tick and commits (60 ms, thread free)
  const a = adm.request({key: 'soul:A', god: false, route: act}) as Extract<Ticket, {turn: unknown}>;
  assert.equal(await a.turn, 'run');
  now += HANDLER; yields.splice(0).forEach(r => r()); await tick();
  now += WAIT_AND_COMMIT; a.done();
  // Soul B's short act arrives as A answers
  const b = adm.request({key: 'soul:B', god: false, route: act}) as Extract<Ticket, {turn: unknown}>;
  let ran = false; void b.turn.then(v => { ran = v === 'run'; });
  for (let i = 0; i < 40 && !ran; i++) { await tick(); if (!ran) { now += 10; await adm.drain(); } }
  assert.ok(ran, 'B ran');
  assert.ok(b.waitedMs() <= HANDLER, `B waited ${b.waitedMs()} ms in admission, more than one handler's time (${HANDLER} ms)`);
  b.done(); adm.close();
});

test('the frame budget follows the tick the world pays under load, not the heavier setup tick', () => {
  const q = new QuietTick();
  assert.equal(q.window(21.4, true, true), 21.4, 'a quiet window during setup');
  assert.equal(q.window(10.6, false, true), 10.6, 'a served window under load whose ticks cost less lowers it');
  assert.equal(frameBudgetMs('amber', q.value), 15, 'amber: the cap, not 0.4 × (50 − 21.4) = 11.4');
  assert.equal(q.window(30, false, true), 10.6, 'a loaded window never raises it');
  assert.equal(q.window(9, false, false), 10.6, 'an unserved window teaches nothing');
});
