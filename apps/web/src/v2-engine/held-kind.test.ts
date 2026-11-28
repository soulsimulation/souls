import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heldKindOf,setHeldKindResolver,entityId} from './held-kind.ts';
test('canonical callback belongs to the live world and stale cleanup cannot clear its replacement',()=>{
  const seen:string[]=[],entry={id:'held',kind:'kind@aa',parent:'body',slot:7,pos:[0,0,0],rot:[1,0,0,0]} as const;
  const first=setHeldKindResolver(e=>{assert.equal(e,entry);seen.push('first');return null;});
  assert.equal(heldKindOf(entry),null);
  const second=setHeldKindResolver(e=>{assert.equal(e,entry);seen.push('second');return null;});
  first();heldKindOf(entry);second();heldKindOf(entry);
  assert.deepEqual(seen,['first','second']);
  const third=setHeldKindResolver(()=>{seen.push('third');return null;});heldKindOf(entry);third();third();heldKindOf(entry);
  assert.deepEqual(seen,['first','second','third'],'world unmount and repeated cleanup leave no resolver');
  assert.equal(entityId('e_fixture'),'e_fixture');assert.equal(entityId('native.body'),entityId('native.body'));
});
