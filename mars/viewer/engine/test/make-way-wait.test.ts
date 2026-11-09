import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../runtime/runtime.ts';
import {DEFAULT_INVARIANTS} from '../runtime/invariants.ts';
import {Spatial} from '../spatial/service.ts';
import {provingGround} from '../scenes/proving-ground.ts';
import {emptyWorld,human,addAll} from '../world/factory.ts';
import type {ActionDef} from '../actions/types.ts';
import {walkTo} from '../locomotion/walk.ts';

// M03 (Soul Actions entry 28): an action for a body that is mid courtesy step-aside waits the nudge out and then runs,
// planned from where the body stands; it used to fail at once with reservation.conflict (only pose_v1 waited).
function fixture(){const scene=provingGround();const world=addAll(emptyWorld('proving-ground',scene),human('a',-6,-6),human('b',-4,-6));const registry=new Map<string,ActionDef>([[walkTo.verb,walkTo]]);const spatial=new Spatial(scene);spatial.sync(world);return {world,rt:new Runtime(world,registry,{spatial},DEFAULT_INVARIANTS)};}
test('a directed walk waits out a make-way nudge on the same body, then walks from where the nudge left it',()=>{
  const {world,rt}=fixture();
  const nudge=rt.submit('walk_to',{actor:'b',x:-4,z:-4.4},{id:'b:make-way:7'});assert.equal(nudge.status,'executing');
  const walk=rt.submit('walk_to',{actor:'b',x:-1,z:-6});
  assert.equal(walk.status,'requested','waits instead of failing');assert.equal(walk.phase,'make-way');
  let started=-1;for(let i=0;i<400&&!['completed','failed'].includes(walk.status as string);i++){rt.step();if(started<0&&(walk.status as string)==='executing')started=rt.tick;}
  assert.equal(rt.records.get('b:make-way:7')!.status,'completed','the nudge finished first');
  assert.ok(started>0,'the walk started after the nudge');assert.equal(walk.status,'completed',JSON.stringify(walk.diagnostic));
  const p=world.entities.b.pose.p;assert.ok(Math.hypot(p[0]+1,p[2]+6)<0.4,'arrived');
});
test('a real conflict (another directed action on the body) still fails at once',()=>{
  const {rt}=fixture();
  const first=rt.submit('walk_to',{actor:'b',x:-1,z:-6},{preempt:false});assert.equal(first.status,'executing');
  const second=rt.submit('walk_to',{actor:'b',x:-6,z:-1},{preempt:false});
  assert.notEqual(second.status,'requested');
});
// #1368: a world captured while an action waits out a make-way nudge must restore. The wait's hold is a live nudge that is
// not cancelling (it runs out by itself), which restore used to reject as `snapshot.waiting-invalid`, so neither rung 3's
// rewind nor a boot from that snapshot could bring the world back.
test('#1368 a make-way wait survives capture and restore, and the restored world steps on identically',()=>{
  const {world,rt}=fixture();
  rt.submit('walk_to',{actor:'b',x:-4,z:-4.4},{id:'b:make-way:7'});
  const walk=rt.submit('walk_to',{actor:'b',x:-1,z:-6});assert.equal(walk.phase,'make-way');
  rt.step();assert.equal(rt.records.get(walk.id)!.status,'requested','still waiting when captured');
  const snap=JSON.parse(JSON.stringify(rt.snapshot()));
  const registry=new Map<string,ActionDef>([[walkTo.verb,walkTo]]);
  const restored=Runtime.restore(snap,registry,{spatial:new Spatial(provingGround())},DEFAULT_INVARIANTS);
  assert.equal(restored.stateHash(),rt.stateHash(),'the same state');
  for(let i=0;i<400;i++){rt.step();restored.step();assert.equal(restored.stateHash(),rt.stateHash(),`tick ${rt.tick}`);}
  assert.equal(restored.records.get(walk.id)!.status,'completed','the waiting walk ran after the nudge, in the copy too');
  const p=world.entities.b.pose.p;assert.ok(Math.hypot(p[0]+1,p[2]+6)<0.4,'arrived');
});
test('#1368 restore still refuses a forged make-way wait whose hold is not a nudge',()=>{
  const {rt}=fixture();
  rt.submit('walk_to',{actor:'b',x:-4,z:-4.4},{id:'b:make-way:7'});
  const walk=rt.submit('walk_to',{actor:'b',x:-1,z:-6});assert.equal(walk.phase,'make-way');
  const other=rt.submit('walk_to',{actor:'a',x:-6,z:-1});assert.equal(other.status,'executing');
  const snap=JSON.parse(JSON.stringify(rt.snapshot()));
  // the wait now claims to be held by a plain walk on another body: a live hold that is neither a nudge nor stopping
  const find=(o:any):any=>{if(!o||typeof o!=='object')return null;if(Array.isArray(o.waiting)&&o.waiting.length)return o;for(const k of Object.keys(o)){const r=find(o[k]);if(r)return r;}return null;};
  const graph=find(snap);assert.ok(graph,'the snapshot carries the wait');graph.waiting[0].holds=[other.id];
  const registry=new Map<string,ActionDef>([[walkTo.verb,walkTo]]);
  assert.throws(()=>Runtime.restore(snap,registry,{spatial:new Spatial(provingGround())},DEFAULT_INVARIANTS),/waiting directive .* has invalid graph provenance/);
});
