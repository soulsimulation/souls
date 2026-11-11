// #2124: an act is not held in admission behind other Souls' short acts because the frame budget was calibrated from a
// quiet tick learned during Soul setup (heavier ticks) and kept under load, where no window is quiet.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Admission, classify, type Ticket} from './load/admission.ts';
import {QuietTick} from './load/monitor.ts';

const act = classify('POST', '/v1/edge/act')!;
const tick = () => new Promise(r => setTimeout(r, 2));

test('two Souls\' short acts: the second is not held behind the first beyond one handler\'s time', async () => {
  // the quiet tick as the monitor learns it: a quiet window during Soul setup (21.4 ms ticks, #2124's measured run), then
  // the world under load, never quiet, its ticks served at 10.6 ms
  const q = new QuietTick();
  q.window(21.4, true, true); q.window(10.6, false, true);
  let now = 1000;
  const adm = new Admission({now: () => now, yieldTurn: () => new Promise(() => {}), quietTickMs: () => q.value});
  adm.setLoadLevel('amber');
  const HANDLER = 18;
  // another Soul's request in flight, so the two acts queue, as under load
  adm.request({key: 'soul:X', god: false, route: classify('GET', '/v1/edge/here')!});
  const ask = (key: string) => {
    const t = adm.request({key, god: false, route: act}) as Extract<Ticket, {turn: unknown}>, out = {t, ran: false};
    void t.turn.then(v => { if (v !== 'run') return; out.ran = true; now += HANDLER; t.done(); });
    return out;
  };
  const a = ask('soul:A'), b = ask('soul:B');
  for (let i = 0; i < 100 && !b.ran; i++) { await tick(); if (!b.ran) now += 1; }
  assert.ok(a.ran && b.ran, 'both ran');
  assert.ok(b.t.waitedMs() <= HANDLER, `B waited ${b.t.waitedMs()} ms in admission, more than one handler's time (${HANDLER} ms)`);
  adm.close();
  assert.equal(q.window(30, false, true), 10.6, 'a loaded window never raises it');
});
