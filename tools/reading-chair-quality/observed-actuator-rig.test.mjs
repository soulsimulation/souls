import test from 'node:test';
import assert from 'node:assert/strict';
import {readingRigFixture,worldVertices} from './rig-fixture.mjs';
const {Runtime}=await import('../../mars/viewer/engine/runtime/runtime.ts');
const {Spatial}=await import('../../mars/viewer/engine/spatial/service.ts');
const {provingGround}=await import('../../mars/viewer/engine/scenes/proving-ground.ts');
const {emptyWorld,human,addAll}=await import('../../mars/viewer/engine/world/factory.ts');
const {handActuator}=await import('../../mars/viewer/engine/social/hand-actuator.ts');
const {TakeRecorder}=await import('../../mars/viewer/engine/take/recorder.ts');
const {TakePeople}=await import('../../mars/viewer/app/engine-view/take-replay.ts');
const {ObservedActuatorIntervals}=await import('../../mars/viewer/app/engine-view/observed-actuator.ts');
const actor='fixture-actor';
function nativeTake(){
  const scene=provingGround(),world=addAll(emptyWorld('fixture-world',scene),human(actor,-6,-6));
  const runtime=new Runtime(world,new Map([[handActuator.verb,handActuator]]),{spatial:new Spatial(scene)},[]);
  const recorder=new TakeRecorder(runtime,{rulesVersion:'fixture-observed-animation',tol:0,fieldTol:{hands:0,speed:0}});
  for(let i=0;i<5;i++)runtime.step();
  const action=runtime.submit(handActuator.verb,{actor,target:'fixture-target',at:[-5.5,1.04,-6]});
  assert.equal(action.status,'executing');for(let i=0;i<65;i++)runtime.step();
  assert.equal(action.status,'completed');assert.deepEqual(runtime.violations,[]);
  const take=recorder.finish(),entry=take.changes.find(c=>c[2]==='handActuator'&&c[3]);
  return {take,upper:entry[0],motion:entry[3]};
}
const skin=p=>worldVertices(p.humans.bodyObject(actor));
const gap=(a,b)=>a.reduce((max,p,i)=>Math.max(max,p.distanceTo(b[i])),0);

test('native actor-only take supplies bounded onset targets without changing recorded hands, frame or source',async()=>{
  const {templates}=await readingRigFixture(),{take,upper,motion}=nativeTake(),saved=structuredClone(take);
  assert.deepEqual(Object.keys(take.tracks),[actor],'target intentionally has no recorded static entity');
  assert.equal(new ObservedActuatorIntervals(take).sample(actor,upper-.5).kind,'certified');
  for(const template of templates){const replay=new TakePeople(take);replay.setTemplates([template]);
    const tick=upper-1+.123456789,time=tick*take.dt;const frame=replay.show(time,time,null,time),v=replay.humans.views.get(actor);
    assert.equal(frame.entities[actor].hands,undefined,'native sample remains lower-null');
    assert.deepEqual(v.cur.hands,{},'posture and engine-hand policy retain the observed sample');
    assert.ok(v.actuatorOnsetHands?.right,'only existing arm target solve receives certified native endpoint');
    assert.equal(v.handActuator.actionId,motion.actionId);
    assert.ok(Math.abs(v.handActuatorTime-(take.startTick+tick)*take.dt)<1e-12,'uses unrounded observed fractional timestamp');
    replay.show((upper+1)*take.dt);assert.equal(v.actuatorOnsetHands,undefined,'field clears outside current interval');
    replay.show((upper-1.1)*take.dt);assert.equal(v.actuatorOnsetHands,undefined,'backward seek cannot retain future targets');
    replay.show(time);assert.ok(v.actuatorOnsetHands?.right,'fresh current-interval seek recertifies');replay.humans.clear();
  }assert.deepEqual(take,saved);
});

test('actual TakePeople onset presentation is independent of seek order and missing lineage falls back',async()=>{
  const {templates}=await readingRigFixture(),{take,upper}=nativeTake(),times=[(upper-1)*take.dt,(upper-.8)*take.dt,(upper-.1)*take.dt,(upper+.1)*take.dt];
  for(const template of templates){const replay=new TakePeople(take);replay.setTemplates([template]);const expected=new Map();
    for(const time of times){replay.show(time);expected.set(time,skin(replay));}
    for(const time of [...times].reverse().concat(times)){replay.show(time);assert.ok(gap(expected.get(time),skin(replay))<1e-9,`${template.name} reverse/repeated`);
      const fresh=new TakePeople(take);fresh.setTemplates([template]);fresh.show(time);assert.ok(gap(expected.get(time),skin(fresh))<1e-9,`${template.name} fresh`);fresh.humans.clear();}
    const missing=structuredClone(take);delete missing.entities0;const fallback=new TakePeople(missing);fallback.setTemplates([template]);fallback.show((upper-.5)*take.dt);
    const v=fallback.humans.views.get(actor);assert.equal(v.handActuator,undefined);assert.equal(v.actuatorOnsetHands,undefined);fallback.humans.clear();replay.humans.clear();
  }
});

test('actual native onset needs no prior task exception and a foreign task cleared at publication falls back',async()=>{
  const {take,upper,motion}=nativeTake(),lower=upper-1;
  const taskChanges=take.changes.filter(c=>c[1]===actor&&c[2]==='task'&&c[0]<=lower);
  const priorTask=taskChanges.length?taskChanges.at(-1)[3]:take.entities0[actor].human.task;
  assert.ok(priorTask===undefined||priorTask===null,'actual recorded lower endpoint has no task owner');
  assert.equal(new ObservedActuatorIntervals(take).sample(actor,lower+.5).kind,'certified');
  for(const task of ['foreign-owner',motion.actionId]){
    const edited=structuredClone(take);edited.entities0[actor].human.task=task;
    edited.changes.push([upper,actor,'task',null]);edited.changes.sort((a,b)=>a[0]-b[0]);
    assert.equal(new ObservedActuatorIntervals(edited).sample(actor,lower+.5).reason,'prior-task-not-clear');
  }
});
