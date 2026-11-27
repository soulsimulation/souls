import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seatTransition} from './seat-transition.ts';
import {SIT_DOWN, STAND_UP, type PostureChange} from './posture-transition.ts';

test('seat phase retargeting starts at the attained entry/exit fraction',()=>{
  const start={from:'idle',to:'sit',age:.3};
  const exit={from:'sit',to:'idle',age:0,before:start};
  assert(Math.abs(seatTransition(exit,'idle')!.fraction-1/3)<1e-10);
  assert(Math.abs(seatTransition(exit,'idle')!.end-.8/3)<1e-10);
  const reenter={from:'idle',to:'sit',age:0,before:{...exit,age:.15,before:{...start,age:.45}}};
  const plan=seatTransition(reenter,'sit')!;
  assert(Math.abs(plan.fraction-(1/3-.15/.8))<1e-10);
  assert.equal(seatTransition({from:'sit',to:'nod',fromBase:'sit',age:1},'nod','sit'),null);
});

test('deep immutable interruptions retain their chronological attained fraction', () => {
  const events = Array.from({length: 48}, (_, i) => ({at: Math.floor(i / 2) * .09 + (i % 2) * .05, entering: i % 2 === 0}));
  const now = events.at(-1)!.at + .03;
  let history: PostureChange | undefined, expected = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i], end = events[i + 1]?.at ?? now;
    expected = Math.max(0, Math.min(1, expected + (end - event.at) * (event.entering ? 1 / SIT_DOWN : -1 / STAND_UP)));
    history = Object.freeze({from: event.entering ? 'idle' : 'sit', to: event.entering ? 'sit' : 'idle', age: now - event.at, before: history});
  }
  const snapshot = JSON.stringify(history);
  for (let i = 0; i < 3; i++) {
    const plan = seatTransition(history, history!.to)!;
    assert(Math.abs(plan.fraction - expected) < 1e-10, 'retargeting agrees with chronological motion through every interruption');
  }
  assert.equal(JSON.stringify(history), snapshot, 'evaluating an origin never changes recorded ages or links');
});
