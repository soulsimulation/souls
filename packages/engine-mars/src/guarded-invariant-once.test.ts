// #1440: the engine guards its runtime's invariants once (a throw is a named `engine.thrown` violation). Before, a list that was
// appended to or swapped back in was wrapped again whole, so each earlier invariant gained one more wrapper every time. Wrapping
// changes no result, so this changes no history; it only keeps the list from growing wrappers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,GREEN_FIELD_WORLD,type MarsEngine} from './engine.ts';

test('#1440 the invariant guard wraps each invariant once, however often the list is replaced',async()=>{
  const f=await marsFactory({...GREEN_FIELD_WORLD,soulsRepairV1:true}),e=f.create(f.genesis('guard-once')) as MarsEngine,rt=(e as any).rt;
  e.step();const guarded=[...rt.invariants];
  const extra=()=>{throw new Error('boom');};
  rt.invariants=[...rt.invariants,extra];e.step();
  assert.equal(rt.invariants.length,guarded.length+1);
  guarded.forEach((g:unknown,i:number)=>assert.equal(rt.invariants[i],g,`invariant ${i} kept its one guard`));
  const added=rt.invariants.at(-1);assert.notEqual(added,extra,'the new one is guarded');
  assert.deepEqual(added(rt).map((v:any)=>v.code),['engine.thrown']);
  rt.invariants=[...rt.invariants];e.step();
  rt.invariants.forEach((g:unknown,i:number)=>assert.equal(g,i<guarded.length?guarded[i]:added,`invariant ${i} not wrapped again`));
});
