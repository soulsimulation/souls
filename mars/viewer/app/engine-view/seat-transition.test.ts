import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seatTransition} from './seat-transition.ts';

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
