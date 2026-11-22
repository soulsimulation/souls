// The driver's loads (Engine v2 I10, #2693): node --test v2/tools/driver/loads.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHAPES, schedule } from '../../../tools/bench/capacity/profiles/shapes.mjs';
import { LADDER, LOADS, TARGET, VERBS, scheduleFile } from './loads.mjs';

test('a3: the target is a copy of the shared event shape, which stays as it was', () => {
  assert.equal(SHAPES.agents.event.presence.value, 0.8);
  assert.equal(SHAPES.agents.event.rate.medianSec.value, 30);
  assert.deepEqual({ ...TARGET, name: undefined, presence: undefined, place: undefined, rate: undefined },
    { ...SHAPES.agents.event, name: undefined, presence: undefined, place: undefined, rate: undefined });
});

test('the target intends about 5,000 acts a minute at 1,000 agents, every one present', () => {
  const s = LOADS.target(1000, 600, 1).summary;
  assert.ok(Math.abs(s.acts / 10 - 5000) <= 250, `${s.acts / 10} a minute`);
  assert.equal(s.present.ever, 1000);
});

test('a4: the stretch is 900 target agents and 100 uniform ones at actSec 0.5, merged', () => {
  const s = LOADS.stretch(1000, 60, 2), slow = schedule(TARGET, 900, 60, 2), fast = schedule('uniform', 100, 60, 2, { actSec: 0.5 });
  assert.equal(s.n, 1000);
  assert.deepEqual(s.parts, ['target', 'uniform']);
  assert.equal(s.summary.acts, slow.summary.acts + fast.summary.acts);
  assert.deepEqual(s.agents[950].acts, fast.agents[50].acts);
  assert.equal(s.agents[950].i, 950);
});

test('a5: every kind of every shared shape has a verb; one with none is written as -', () => {
  for (const [name, shape] of Object.entries(SHAPES.agents)) for (const kind of Object.keys(shape.mix.value)) assert.ok(VERBS[kind], `${name}: ${kind}`);
  const file = scheduleFile('x', { n: 1, seconds: 1, seed: 1, agents: [{ i: 0, acts: [{ at: 0.5, kind: 'juggle' }, { at: 0.25, kind: 'say' }] }], summary: LOADS['target-even'](1, 1, 1).summary });
  assert.deepEqual(file.split('\n').slice(1), ['250 0 say eden:say', '500 0 juggle -', '']);
});

test('X7 a3: each ladder step has an uneven arm (event as it is) and an even one (uniform) intending about as many acts', () => {
  for (const n of LADDER) {
    const u = LOADS[`ladder-${n}-uneven`](1, 60, 1), e = LOADS[`ladder-${n}-even`](1, 60, 1);
    assert.deepEqual([u.shape, u.n, e.shape, e.n], ['event', n, 'uniform', n]);
    assert.ok(Math.abs(e.summary.acts - u.summary.acts) <= Math.max(5, 0.1 * u.summary.acts), `${n}: ${e.summary.acts} against ${u.summary.acts}`);
  }
});
