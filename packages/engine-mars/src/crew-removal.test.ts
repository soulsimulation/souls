import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory,GREEN_FIELD_WORLD } from './engine.ts';

test('candidate crew removal has explicit rule identity and refuses cross-policy checkpoint restoration',async()=>{
  const legacy=await marsFactory(GREEN_FIELD_WORLD),candidate=await marsFactory({...GREEN_FIELD_WORLD,safeCrewRemoval:true});
  assert.equal(candidate.rulesVersion,legacy.rulesVersion+'+crew-removal/1');
  assert.equal(candidate.canRestoreSnapshot!(legacy.rulesVersion),false);assert.equal(legacy.canRestoreSnapshot!(candidate.rulesVersion),false);
  assert.equal(candidate.canRestoreSnapshot!(candidate.rulesVersion),true);
  const old=legacy.create(legacy.genesis('version')),next=candidate.create(candidate.genesis('version'));
  assert.notEqual(old.stateHash(),next.stateHash());assert.equal(legacy.restore(old.snapshot()).stateHash(),old.stateHash());assert.equal(candidate.restore(next.snapshot()).stateHash(),next.stateHash());
  assert.throws(()=>candidate.restore(old.snapshot()),/removal policy differs/);assert.throws(()=>legacy.restore(next.snapshot()),/removal policy differs/);
});

test('candidate removal leaves ordinary native walk cancellation intact and checkpoints its own policy',async()=>{
  const f=await marsFactory({...GREEN_FIELD_WORLD,safeCrewRemoval:true}),e=f.create(f.genesis('walking-removal'));
  e.spawnHuman({id:'h_A',label:'Alice',soul:'s_A'});assert.equal(e.perform({actor:'h_A',label:'walk',steps:[{verb:'walk_to',params:{to:[12,0,5]}}]}).ok,true);
  for(let i=0;i<40;i++)e.step();assert.equal(e.world.entities.h_A.human!.activity,'walk');
  e.removeEntity('h_A');assert.equal(e.world.entities.h_A,undefined);assert.equal(e.programOf('h_A'),null);assert.deepEqual(e.runtime.violations,[]);
  const restored=f.restore(e.snapshot());assert.equal(restored.stateHash(),e.stateHash());assert.equal(restored.rulesVersion,f.rulesVersion);
});

test('#1250: under repair, retiring a conversation partner lets the conversation go and the initiator goes on to its next step',async()=>{
  const f=await marsFactory({...GREEN_FIELD_WORLD,soulsRepairV1:true}),e:any=f.create(f.genesis('converse-removal'));
  e.spawnHuman({id:'h_A',label:'A',soul:'s_A'});e.spawnHuman({id:'h_B',label:'B',soul:'s_B'});
  const evs:string[]=[],step=()=>{const o=e.step();for(const x of o.programs??[])evs.push(`${x.kind}:${x.step}`);};
  for(let i=0;i<20;i++)step();
  assert.equal(e.perform({actor:'h_A',label:'talk then wave',steps:[{verb:'converse',params:{with:'h_B',seconds:20}},{verb:'wave',params:{seconds:3}}]}).ok,true);
  for(let i=0;i<60;i++)step();
  e.removeEntity('h_B');for(let i=0;i<300;i++)step();
  assert.equal(e.world.entities.h_B,undefined,'B leaves');
  assert.ok(evs.includes('step:1'),`A's wave runs: ${evs.join(' ')}`);assert.ok(evs.includes('completed:-1'),`and A's programme completes: ${evs.join(' ')}`);
});
