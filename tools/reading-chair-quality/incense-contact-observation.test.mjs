import test from 'node:test';
import assert from 'node:assert/strict';
import {IncenseExtraOwners,incenseEmptyOwnership} from '../../mars/viewer/app/engine-view/incense-contact-observation.ts';

const motion={target:'censer',at:[0,1.093,0],startTick:10,actionId:'light'};
const take=()=>({schema:'mars-take/4',entities0:{actor:{id:'actor',kind:'human',human:{}}},changes:[[0,'actor','present',true]]});
test('empty-handed observations resolve every ownership slot and never infer other-hand ownership away',()=>{
  const own=incenseEmptyOwnership({}, {right:[0,1,0]},motion,undefined,.65);
  assert.ok(own);assert.deepEqual(own.right.nativeTarget,[0,1,0]);assert.equal(own.left.nativeTarget,null);
  assert.deepEqual(own.left.heldItems,[]);
  for(const key of ['grip','heldItemsV1','itemTransferV1','handTransferV1','wateringV1','cupV1','letGoV1','sleepPose','prop','instrument','game','partner','handHold','rps','on','carryContactV1','juggleV1','together'])
    assert.equal(incenseEmptyOwnership({[key]:{owner:true}},{right:[0,1,0]},motion,undefined,.65),null,key);
  assert.equal(incenseEmptyOwnership({}, {left:[0,1,0],right:[0,1,0]},motion,undefined,.65),null);
  assert.equal(incenseEmptyOwnership({}, {right:[NaN,1,0]},motion,undefined,.65),null);
  assert.equal(incenseEmptyOwnership({}, undefined,motion,{weight:1},.65),null);
});
test('extra-owner certificate checks the whole bounded onset interval without borrowing final state',()=>{
  for(const key of ['carryContactV1','juggleV1','together']){
    const source=take();source.changes.push([2,'actor',key,{owner:true}],[3,'actor',key,null]);
    const index=new IncenseExtraOwners(source);
    assert.equal(index.clear('actor',0,1),true);
    assert.equal(index.clear('actor',1,3),false,key);
    assert.equal(index.clear('actor',2,2.5),false,key);
    assert.equal(index.clear('actor',3,4),true);
  }
  const owned=take();owned.entities0.actor.human.holding='book';assert.equal(new IncenseExtraOwners(owned).clear('actor',0),false);
  assert.equal(new IncenseExtraOwners({...take(),schema:'unknown'}).clear('actor',0),false);
  const missing=take();delete missing.entities0.actor.human;assert.equal(new IncenseExtraOwners(missing).clear('actor',0),false);
  const unordered=take();unordered.changes.push([3,'actor','present',true],[2,'actor','juggleV1',null]);
  assert.equal(new IncenseExtraOwners(unordered).clear('actor',4),false);
});
