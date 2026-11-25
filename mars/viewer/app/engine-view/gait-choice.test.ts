import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseGait, DWELL, HOLD, RUN_ENTER, RUN_LEAVE, type GaitChoice } from './gait-choice.ts';

const DT = 0.05;
/** The drawn gait, tick by tick, for speeds `v(t)` over `secs`; → the number of changes and the running ticks. */
function play(v: (t: number) => number, secs: number, named = (_t: number) => false) {
  let s: GaitChoice | undefined, changes = 0, running = 0;
  for (let k = 0; k * DT <= secs; k++) {
    const t = 100 + k * DT, was = s?.running;
    s = chooseGait(s, v(k * DT), t, named(k * DT));
    if (was !== undefined && was !== s.running) changes++;
    if (s.running) running++;
  }
  return { changes, running };
}

test('a walk with speed bumps across the jog threshold is drawn walking throughout', () => {
  // 1.4 m/s with a 0.25 s burst to 2.6 m/s every second (a late part, a step around someone)
  const r = play((t) => (t % 1 >= 0.5 && t % 1 < 0.75 ? 2.6 : 1.4), 30);
  assert.equal(r.changes, 0);
  assert.equal(r.running, 0);
});

test('a speed hovering about the threshold does not flip the gait moment to moment', () => {
  // around 2.3 m/s, either side every other tick: the old single threshold changed gait every 50 ms
  const r = play((t) => (Math.round(t / DT) % 2 ? RUN_ENTER + 0.1 : RUN_ENTER - 0.1), 30);
  assert.ok(r.changes <= 1, `${r.changes} changes`);
});

test('a steady jog is drawn jogging after DWELL, and a walk again after it slows', () => {
  let s = chooseGait(undefined, 1.4, 0), t = 0;
  while (t < 5) { t += DT; s = chooseGait(s, 1.4, t); }
  t = 5;
  while (!s.running && t < 10) { t += DT; s = chooseGait(s, 2.5, t); }
  assert.ok(s.running);
  assert.ok(t - 5 >= DWELL - 1e-9 && t - 5 <= DWELL + 2 * DT, `jogging after ${(t - 5).toFixed(2)} s`);
  const from = t;
  while (s.running && t < 20) { t += DT; s = chooseGait(s, RUN_LEAVE - 0.2, t); }
  assert.ok(!s.running);
  assert.ok(t - from >= HOLD - 1e-9, `kept jogging ${(t - from).toFixed(2)} s`);
});

test('between the two thresholds the gait already drawn is kept', () => {
  let s = chooseGait(undefined, 2.5, 0);
  assert.ok(s.running);
  for (let t = DT; t < 5; t += DT) s = chooseGait(s, (RUN_ENTER + RUN_LEAVE) / 2, t);
  assert.ok(s.running);
  s = chooseGait(undefined, 1.4, 0);
  for (let t = DT; t < 5; t += DT) s = chooseGait(s, (RUN_ENTER + RUN_LEAVE) / 2, t);
  assert.ok(!s.running);
});

test('a gait the engine names is drawn at once; a seek starts afresh', () => {
  let s = chooseGait(undefined, 1.4, 0);
  s = chooseGait(s, 1.4, DT, true);
  assert.ok(s.running);
  s = chooseGait(s, 1.4, 50);
  assert.ok(!s.running, 'after a jump in the clock the speed decides at once');
  s = chooseGait(s, 3, 40);
  assert.ok(s.running, 'a seek back decides at once');
});
