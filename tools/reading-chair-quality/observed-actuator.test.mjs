import test from 'node:test';
import assert from 'node:assert/strict';
import {ObservedActuatorIntervals} from '../../mars/viewer/app/engine-view/observed-actuator.ts';

const actor='fixture-actor',target='fixture-target';
const episode=()=>({actor,target,at:[.3,1.1,0],startTick:107,actionId:'fixture-action',hand:'right'});
const fixture=()=>({dt:.05,startTick:100,ticks:15,entities0:{[actor]:{id:actor,kind:'human',human:{activity:'idle',level:0}}},
  tracks:{[actor]:[[0,0,0,0,0],[15,0,0,0,0]]},changes:[[0,actor,'present',true],[0,actor,'activity','idle'],[8,actor,'handActuator',episode()],[8,actor,'activity','operate'],[8,actor,'hands',{right:[300,1100,0]}],[12,actor,'handActuator',null],[12,actor,'hands',null]],finalState:{entities:{}}});
const sample=(take,tick=7.5)=>new ObservedActuatorIntervals(take).sample(actor,tick);

test('actor-only recorded native episode qualifies only its bounded adjacent onset interval',()=>{
  const take=fixture(),saved=structuredClone(take),index=new ObservedActuatorIntervals(take);
  assert.equal(Object.keys(take.tracks).length,1,'static target track is intentionally absent');
  const a=index.sample(actor,7.5);assert.equal(a.kind,'certified');assert.deepEqual(a.motion,episode());
  assert.deepEqual(a.hands,{right:[.3,1.1,0]});
  assert.equal(a.lower,7);assert.equal(a.upper,8);
  for(const tick of [0,6.999,8,11.5,12,14.999])assert.equal(index.sample(actor,tick).kind,'fallback',String(tick));
  for(const tick of [7.99,7,7.5,7.5])assert.deepEqual(index.sample(actor,tick),a);
  assert.deepEqual(take,saved,'no native recording mutation');
});

test('missing and ambiguous episode/lineage/prior ownership conservatively reject with explicit reasons',()=>{
  const check=(edit,reason)=>{const t=fixture();edit(t);assert.equal(sample(t).reason,reason);};
  check(t=>delete t.entities0,'missing-actor-lineage');
  check(t=>t.entities0[actor].id='foreign-actor','missing-actor-lineage');
  check(t=>t.changes[2][3].actionId=undefined,'invalid-native-episode');
  check(t=>t.changes[2][3].target='','invalid-native-episode');
  check(t=>t.changes[2][3].at=[NaN,1,0],'invalid-native-episode');
  check(t=>t.changes[2][3].actor='foreign-actor','invalid-native-episode');
  check(t=>t.changes[2][3].hold=NaN,'invalid-native-episode');
  check(t=>t.changes[2][3].startTick=106,'start-outside-interval');
  check(t=>t.changes[2][3].startTick=108,'start-outside-interval');
  check(t=>t.entities0[actor].human.grip={entity:'other-owner'},'prior-ownership-not-clear');
  check(t=>t.changes.splice(2,0,[7,actor,'hands',{left:[0,0,0]}]),'prior-ownership-not-clear');
  check(t=>t.changes.splice(3,0,[8,actor,'handActuator',{...episode(),target:'other-target'}]),'mixed-interval-owner');
  check(t=>t.changes.splice(3,0,[8,actor,'grip',{entity:'other-owner'}]),'mixed-interval-owner');
  check(t=>t.changes.splice(2,0,[7,actor,'present',false]),'removed-actor-lineage');
  check(t=>t.changes[0][3]=false,'removed-actor-lineage');
});

test('aborted, missing, completed, or prior episodes cannot resurrect through onset lookup',()=>{
  const aborted=fixture();aborted.changes[2][3].abortedAt=.02;
  assert.equal(sample(aborted).reason,'invalid-native-episode');
  const missing=fixture();missing.changes=missing.changes.filter(c=>c[2]!=='handActuator');
  assert.equal(sample(missing).reason,'no-current-interval-episode');
  const later=fixture();later.changes.push([13,actor,'handActuator',{...episode(),startTick:107}]);
  assert.equal(sample(later,12.5).reason,'start-outside-interval');
  const ended=fixture();ended.changes.splice(3,0,[8,actor,'handActuator',null]);
  assert.equal(sample(ended).reason,'mixed-interval-owner');
  assert.equal(sample(fixture(),NaN).reason,'outside-recording');
  assert.equal(sample(fixture(),15).reason,'outside-recording');
});

test('prior activity and every recorded hand owner block onset; endpoint hands must match native hand ownership',()=>{
  for(const activity of ['read','play-guitar','wave','rps','hold-hands','sleep']){const t=fixture();t.changes[1][3]=activity;assert.equal(sample(t).reason,'prior-activity-not-clear',activity);}
  for(const [key,value] of Object.entries({prop:'book',instrument:'guitar',game:{kind:'rps'},handHold:{with:'other-actor'},rps:{with:'other-actor'},heldItemsV1:{left:'fixture-item'}})){
    const t=fixture();t.entities0[actor].human[key]=value;assert.equal(sample(t).reason,'prior-ownership-not-clear',key);
  }
  const missing=fixture();missing.changes=missing.changes.filter(c=>c[2]!=='hands');assert.equal(sample(missing).reason,'missing-or-mixed-endpoint-hands');
  const mixed=fixture();mixed.changes.find(c=>c[2]==='hands')[3].left=[0,1100,0];assert.equal(sample(mixed).reason,'missing-or-mixed-endpoint-hands');
  const wrong=fixture();wrong.changes[2][3].hand='left';assert.equal(sample(wrong).reason,'missing-or-mixed-endpoint-hands');
  const complete=fixture();complete.dt=3;assert.equal(sample(complete).reason,'completed-episode');
});

test('a prior task cleared at the upper endpoint cannot borrow the preceding interval, including the same action id',()=>{
  for(const task of ['foreign-owner',episode().actionId,'']){
    const t=fixture();t.entities0[actor].human.task=task;
    t.changes.splice(2,0,[8,actor,'task',null]);
    assert.equal(sample(t).reason,'prior-task-not-clear',JSON.stringify(task));
  }
  for(const task of [null,undefined]){const t=fixture();t.entities0[actor].human.task=task;assert.equal(sample(t).kind,'certified');}
});

test('index construction visits recorded changes a bounded number of times and lookup never re-reads them',()=>{
  for(const publications of [80,160]){
    const t=fixture();t.startTick=0;t.ticks=publications*10+10;t.changes=[[0,actor,'present',true],[0,actor,'activity','idle']];
    for(let i=0;i<publications;i++){
      const upper=10*i+3,m={...episode(),startTick:upper-1,actionId:`fixture-action-${i}`};
      t.changes.push([upper-1,actor,'fixture-field',i],[upper,actor,'handActuator',m],[upper,actor,'activity','operate'],[upper,actor,'hands',{right:[300,1100,0]}],
        [upper+1,actor,'handActuator',null],[upper+1,actor,'activity','idle'],[upper+1,actor,'hands',null]);
    }
    Object.defineProperty(t.entities0[actor].human,'unrelatedPayload',{get(){throw Error('unrelated history is not certification state');}});
    let reads=0;t.changes=t.changes.map(change=>new Proxy(change,{get(target,key,receiver){if(typeof key==='string'&&/^[0-3]$/.test(key))reads++;return Reflect.get(target,key,receiver);}}));
    const index=new ObservedActuatorIntervals(t),constructedReads=reads;
    assert.ok(reads<=12*t.changes.length+256,`${publications} publications: ${reads} cell reads for ${t.changes.length} changes`);
    for(let i=0;i<publications;i++)assert.equal(index.sample(actor,10*i+2.5).kind,'certified');
    assert.equal(reads,constructedReads,'render lookup is a map query, never a source-history scan');
  }
});
