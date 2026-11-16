import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD, EDEN_COMMONS_WORLD, EDEN_SAFE_COMMONS_WORLD } from './engine.ts';
import { probeNativeHumanBirth, placeNativeHumanBirth, nativeBirthPlacement } from './birth.ts';
import { groundFact } from './ground-bridge.ts';
import { loadMars } from './load.ts';
import { emptyGround } from '../../ground/src/index.ts';
import type { Engine } from '@souls/engine-contract';
const factory=await marsFactory(GREEN_FIELD_WORLD);
const request={id:'h_new',label:'New',soul:'s_new'};
function saved(e:Engine){return {hash:e.stateHash(),world:JSON.stringify(e.world),records:JSON.stringify([...e.runtime.records]),scene:JSON.stringify(e.renderScene?.()),takes:JSON.stringify(e.takeChunks?.(-1))};}

test('detached native placement matches actual spawn with existing occupants and preserves all live evidence',()=>{
  const e=factory.create(factory.genesis('birth-probe'));
  e.spawnHuman({id:'h_A',label:'Alice',soul:'s_A'});e.spawnHuman({id:'h_B',label:'Bob',soul:'s_B'});
  const before=saved(e),snapshot=e.snapshot();
  const result=probeNativeHumanBirth(e,factory,request);assert.equal(result.outcome,'ready');
  for(let i=0;i<8;i++)assert.deepEqual(probeNativeHumanBirth(e,factory,request),result);
  assert.deepEqual(saved(e),before);assert.deepEqual(e.snapshot(),snapshot);
  assert.equal(Object.hasOwn(e.world.entities,'h_new'),false);
  e.spawnHuman(request);assert.ok('position'in result);assert.deepEqual(e.world.entities.h_new.pose.p,result.position);
  assert.equal(e.world.entities.h_new.human!.soul,'s_new');assert.deepEqual(e.runtime.violations,[]);
});

test('actual unavailable arrival gets detached refusal without an authoritative body or changed RNG',async()=>{
  const f=await marsFactory({...GREEN_FIELD_WORLD,arrival:[500,500],reference:[501,500]});const e=f.create(f.genesis('bad-arrival')),before=saved(e);
  const result=probeNativeHumanBirth(e,f,request);assert.equal(result.outcome,'unavailable');
  assert.ok('diagnostic'in result);assert.equal(result.diagnostic.code,'birth.arrival-unavailable');assert.deepEqual(saved(e),before);
  assert.throws(()=>e.spawnHuman(request),/no free standing room/);assert.equal(e.world.entities.h_new,undefined);
});

test('identity reuse distinguishes matching body from conflicting body without inheriting legacy blind id reuse',()=>{
  const e=factory.create(factory.genesis('identity'));e.spawnHuman(request);const before=saved(e);
  assert.equal(probeNativeHumanBirth(e,factory,request).outcome,'existing');
  for(const change of [{soul:'s_else'},{label:'Other'}]){
    const result=probeNativeHumanBirth(e,factory,{...request,...change});assert.equal(result.outcome,'unavailable');assert.ok('diagnostic'in result);assert.equal(result.diagnostic.code,'birth.identity-conflict');
  }
  assert.deepEqual(saved(e),before);
});

test('strict bounded internal input rejects malformed/private fields before any native state access',()=>{
  const e=factory.create(factory.genesis('validation')),before=saved(e);
  for(const raw of [{...request,owner:'private'},{...request,id:''},{...request,soul:'x'.repeat(97)},{...request,label:'x'.repeat(81)},{...request,id:3},null])assert.throws(()=>probeNativeHumanBirth(e,factory,raw));
  assert.deepEqual(saved(e),before);assert.throws(()=>probeNativeHumanBirth(e,{...factory,rulesVersion:'wrong'},request),/matching native/);
});

test('resumable native walk is preserved and continues identically after detached probe',()=>{
  const e=factory.create(factory.genesis('walking'));e.spawnHuman({id:'h_A',label:'Alice',soul:'s_A'});
  const walking=e.perform({actor:'h_A',label:'walk',steps:[{verb:'walk_to',params:{to:[12,0,5]}}]});assert.equal(walking.ok,true);
  for(let i=0;i<40;i++)e.step();assert.equal(e.world.entities.h_A.human!.activity,'walk');assert.equal(e.canSnapshot!(),true);
  const before=saved(e),control=factory.restore(e.snapshot());assert.equal(probeNativeHumanBirth(e,factory,request).outcome,'ready');assert.deepEqual(saved(e),before);
  for(let i=0;i<80;i++){e.step();control.step();}assert.equal(e.stateHash(),control.stateHash());
});

test('actually non-resumable native sleep defers without serializing or disturbing the sleeper',async()=>{
  const f=await marsFactory({scene:'eden-camp',arrival:[16,-10],arrivalPlace:'bunkhouse',reference:[16,-9],grounds:{id:'grounds',name:'grounds'}});
  const e=f.create(f.genesis('sleeping'));e.spawnHuman({id:'h_A',label:'Alice',soul:'s_A'});
  assert.equal(e.perform({actor:'h_A',label:'sleep',steps:[{verb:'mars:sleep',params:{mat:'mat-1',duration:600}}]}).ok,true);
  for(let i=0;i<1800&&e.world.entities.h_A.human!.activity!=='sleep';i++)e.step();assert.equal(e.world.entities.h_A.human!.activity,'sleep');assert.equal(e.canSnapshot!(),false);
  const before=saved(e),result=probeNativeHumanBirth(e,f,request);assert.equal(result.outcome,'deferred');assert.ok('diagnostic'in result);assert.equal(result.diagnostic.code,'birth.checkpoint-required');assert.deepEqual(saved(e),before);
});

test('checkpoint corruption and unexpected native faults propagate instead of becoming ordinary arrival refusal',()=>{
  const e=factory.create(factory.genesis('faults')),before=saved(e);
  const advanced={...factory,restore:(snapshot:Parameters<typeof factory.restore>[0])=>{const copy=factory.restore(snapshot);copy.step();return copy;}};
  assert.throws(()=>probeNativeHumanBirth(e,advanced,request),/did not restore exactly/);assert.deepEqual(saved(e),before);
  const original=e.snapshot.bind(e);e.snapshot=()=>{throw new Error('isolated unexpected codec invariant');};
  assert.throws(()=>probeNativeHumanBirth(e,factory,request),/unexpected codec invariant/);assert.deepEqual(saved(e),before);e.snapshot=original;
});

// A13 (#2621): the birth path places on the live engine (placeNativeHumanBirth); the detached probe is its oracle.
type Request={id:string;label:string;soul:string;near?:{at:[number,number];first?:boolean}};
/** The navigation's epoch and ground windows: derived state the state hash cannot see (#2624 review). */
const navOf=(e:Engine)=>{const sp=(e as unknown as {rt:{services:{spatial:{epoch:unknown;ground?:{window?:unknown;windows?:unknown}}}}}).rt.services.spatial;
  return JSON.stringify({epoch:sp.epoch,window:sp.ground?.window??null});};
/** The live placement equals the probe's outcome (placement or refusal, same diagnostic), neither changes the world, and
 *  the live placement leaves the navigation as it found it once synced (the probe's own snapshot syncs the live scene to
 *  the world, as any step does; a fresh world's first sync moves the epoch 0 -> 1). */
function agrees(e:Engine,f:typeof factory,raw:Request){
  const hash=e.stateHash(),tick=e.world.tick;
  const {contract:_c,base:_b,...probe}=probeNativeHumanBirth(e,f,raw),nav=navOf(e);
  const placed=placeNativeHumanBirth(e,raw);
  assert.deepEqual(placed,probe,JSON.stringify(raw));assert.equal(e.stateHash(),hash);assert.equal(e.world.tick,tick);assert.equal(navOf(e),nav,'navigation moved');
  return placed;
}
test('A13 oracle: the live placement equals the detached probe on every birth while a crowd fills the arrival point',async t=>{
  for(const [name,cfg] of [['green field',GREEN_FIELD_WORLD],['commons',EDEN_COMMONS_WORLD],['safe commons',EDEN_SAFE_COMMONS_WORLD]] as const){
    const f=await marsFactory(cfg),e=f.create(f.genesis('oracle-'+name));let ready=0,refused=0,hinted=0;
    for(let i=0;i<110&&refused<4;i++){
      const req={id:'h_'+i,label:'Resident '+i,soul:'s_'+i},p=agrees(e,f,req);
      if(p.outcome==='ready'){e.spawnHuman(req);assert.deepEqual(e.world.entities[req.id].pose.p,p.position);ready++;}
      else{
        refused++;
        // the hinted forms the server sends once the rings are full: the arrival point itself, and a searched start
        for(const near of [{at:[cfg.arrival[0],cfg.arrival[1]] as [number,number]},{at:[cfg.arrival[0]+6,cfg.arrival[1]-4] as [number,number],first:true}]){
          const q={...req,near},h=agrees(e,f,q);
          if(h.outcome==='ready'&&!e.world.entities[req.id]){e.spawnHuman(q);assert.deepEqual(e.world.entities[req.id].pose.p,h.position);hinted++;}
        }
      }
      // two bodies keep walking between births: the live engine is mid-action, as a served world is
      if(i===4)for(const a of ['h_0','h_1'])assert.equal(e.perform({actor:a,label:'walk',steps:[{verb:'walk_to',params:{to:[cfg.arrival[0]+10,0,cfg.arrival[1]+6]}}]}).ok,true);
      for(let t=0;t<3;t++)e.step();
    }
    t.diagnostic(`${name}: ${ready} ready, ${refused} refused, ${hinted} hinted`);assert.ok(ready>=10&&refused>=1&&hinted>=1,name);
  }
});

test('A13 oracle: existing, conflicting and deferred births answer as the probe does',async()=>{
  const e=factory.create(factory.genesis('oracle-identity'));e.spawnHuman(request);
  assert.equal(agrees(e,factory,request).outcome,'existing');
  assert.equal(agrees(e,factory,{...request,soul:'s_else'}).outcome,'unavailable');
  const f=await marsFactory({scene:'eden-camp',arrival:[16,-10],arrivalPlace:'bunkhouse',reference:[16,-9],grounds:{id:'grounds',name:'grounds'}});
  const s=f.create(f.genesis('oracle-sleeping'));s.spawnHuman({id:'h_A',label:'Alice',soul:'s_A'});
  assert.equal(s.perform({actor:'h_A',label:'sleep',steps:[{verb:'mars:sleep',params:{mat:'mat-1',duration:600}}]}).ok,true);
  for(let i=0;i<1800&&s.world.entities.h_A.human!.activity!=='sleep';i++)s.step();
  assert.equal(agrees(s,f,request).outcome,'deferred');
});

test('A13: the birth path never snapshots or restores; SIM_BIRTH_PROBE=1 decides by the probe, =oracle throws on a difference',()=>{
  let restores=0,snapshots=0;
  const counted={...factory,restore:(s:Parameters<typeof factory.restore>[0])=>{restores++;return factory.restore(s);}};
  const e=factory.create(factory.genesis('oracle-modes'));e.spawnHuman({id:'h_A',label:'Alice',soul:'s_A'});
  const snap=e.snapshot.bind(e);e.snapshot=()=>{snapshots++;return snap();};
  const m=e as unknown as {birthPlacementV1:(r:unknown)=>unknown},own=m.birthPlacementV1;
  try{
    const p=nativeBirthPlacement(e,counted,request);assert.equal(p.outcome,'ready');assert.equal(restores+snapshots,0);
    assert.deepEqual(nativeBirthPlacement(e,counted,request,'1'),p);assert.equal(restores,1);
    assert.deepEqual(nativeBirthPlacement(e,counted,request,'oracle'),p);assert.equal(restores,2);
    m.birthPlacementV1=()=>({ok:true,p:[9,0,9]});assert.throws(()=>nativeBirthPlacement(e,counted,request,'oracle'),/differs from the detached probe/);
  }finally{e.snapshot=snap;m.birthPlacementV1=own;}
});

// #2624 review: on whole (non-paged) ground the live search grew the ground window to an arrival point far from every
// body and moved the epoch, so a later far walk was refused live (ground.too-far) and admitted on replay. Such a world
// keeps the probe, and its navigation and later walks are those of a world that never placed a birth.
test('A13: on whole (non-paged) ground the birth decides by the probe and leaves the navigation as it was',async()=>{
  const m=await loadMars(),f=await marsFactory({...GREEN_FIELD_WORLD,arrival:[300,0],reference:[302,0]}),fact=groundFact(emptyGround(1000),4,{paged:false});
  const mk=()=>{const w=f.genesis('a13-whole') as {entities:Record<string,unknown>};w.entities.h_home=m.human('h_home',0,0,{label:'Home'});
    const e=f.create(w as never) as Engine&{installGroundV1(f:unknown):unknown};e.installGroundV1(fact);for(let t=0;t<3;t++)e.step();return e;};
  const a=mk(),b=mk(),nav=navOf(a);
  for(const mode of [undefined,'oracle']){
    const {contract:_c,base:_b,...probe}=probeNativeHumanBirth(a,f,request);assert.deepEqual(nativeBirthPlacement(a,f,request,mode),probe);
  }
  assert.throws(()=>placeNativeHumanBirth(a,request),/needs paged ground or none/);
  assert.equal(navOf(a),nav);assert.equal(navOf(a),navOf(b));
  for(const e of [a,b])assert.equal(e.perform({actor:'h_home',label:'walk',steps:[{verb:'walk_to',params:{to:[-100,0,0]}}]}).ok,true);
  for(let t=0;t<20;t++){a.step();b.step();}
  assert.equal(a.stateHash(),b.stateHash());
});
