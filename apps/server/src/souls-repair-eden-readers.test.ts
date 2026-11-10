// #1323 R6: every reader edenHistoryFactory can return accepts the repair adoption. The full Eden stack as production runs it
// (retained shore with its physical binding, newcomer resources, sleep snapshots, ground, lecture) is built under 4.16's rules,
// then booted by the server's reader, adopted at its head, and booted again from its snapshot and from genesis.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {edenLectureFactoryV1,edenGroundFactoryV1,retainedCommonsShoreFactory,commonsNewcomerResourcesFactory,nativeSleepSnapshotFactoryV1,
  marsFactory,marsCrewRemovalTransitionFactory,marsCommonsTransitionFactory,GREEN_FIELD_WORLD,EDEN_SAFE_COMMONS_WORLD,soulsRepairReaderV1} from '@souls/engine-mars';
import type {EngineFactory} from '@souls/engine-contract';
import {kernelHash} from '@souls/kernel';
import {fixture,invite,accept} from '../test/native-owner-fixture.ts';
import {WorldHost} from './world.ts';
import {Db} from './db.ts';
import {edenHistoryFactory} from './eden-bootstrap.ts';

const REPAIR=/\+souls-repair\/1/;
const placement={worldEast:'world-v2' as const,id:'eden-classroom-1',origin:[42,-6] as [number,number],yaw:0,audienceSeats:20 as const,lesson:'Eden: observe a world, give a direction, watch what changes.'};
const head=(h:WorldHost)=>({tick:h.engine.world.tick,rules:h.engine.rulesVersion,engine:h.engine.stateHash(),kernel:kernelHash(h.kernel)});
const run=(h:WorldHost,n:number)=>{for(let i=0;i<n;i++){h.tickOnce();h.drainInputs();}};

test('R6 the origin readers: each adopts, restores its own snapshot under the rules, and checks the adopted head',async()=>{
  const readers:[string,EngineFactory][]=[
    ['new Eden',await marsFactory({...EDEN_SAFE_COMMONS_WORLD,safeCrewRemoval:true})],
    ['crew-removal transition',await marsCrewRemovalTransitionFactory()],
    ['commons transition',await marsCommonsTransitionFactory({...GREEN_FIELD_WORLD,safeCrewRemoval:true},{safeArrivalV1:true})],
  ];
  for(const [name,inner] of readers){
    const w=soulsRepairReaderV1(inner,{adopt:true}),e=w.create(inner.genesis('repair-readers'));
    for(let i=0;i<20;i++)e.step();
    const p=e.previewSoulsRepairAdoptionV1!();assert.ok(p.ok,name);const to=p.ok?p.transition.toRulesVersion:'';
    assert.equal(to.replace('+souls-repair/1',''),inner.rulesVersion,name);
    assert.equal(w.canReplayHistory!(inner.rulesVersion),true,name);assert.equal(w.canReplayHistory!(to),true,name);assert.equal(w.canRestoreSnapshot!(to),true,name);
    assert.equal(w.canReplayHistory!(to+'+souls-repair/1'),false,name);
    e.adoptSoulsRepairV1!(p.ok?p.transition:undefined as never);assert.equal(e.rulesVersion,to,name);
    for(let i=0;i<20;i++)e.step();
    const r=w.restore(e.snapshot());assert.equal(r.rulesVersion,to,name);assert.equal(r.stateHash(),e.stateHash(),name);
    w.validateHistoryHead?.(r,to);
    for(let i=0;i<20;i++){e.step();r.step();}assert.equal(r.stateHash(),e.stateHash(),name);
    assert.equal(inner.canReplayHistory?.(to),false,`${name}: 4.16's reader refuses the adopted history`);
  }
});

test('R6 the full Eden stack built under 4.16 adopts at its head, and its snapshot and genesis boots reach the same world',{timeout:600000},async t=>{
  t.mock.method(console,'log',()=>{});t.mock.method(console,'warn',()=>{});
  const dir=mkdtempSync(join(tmpdir(),'repair-eden-')),path=join(dir,'world.db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const old=nativeSleepSnapshotFactoryV1(edenLectureFactoryV1(commonsNewcomerResourcesFactory(await edenGroundFactoryV1(await retainedCommonsShoreFactory({socialEdenV1:true,foodDeliveryV1:true})))));
  const f=fixture(path,old,{durableClockV1:true});f.brain.quiesce();
  for(const m of ['installCommonsProvisionsV1','installCommonsKitchenV1','installRetainedCommonsShoreV1'] as const)await accept<unknown>(f.host,f.host[m]());
  const layout=JSON.parse(readFileSync(new URL('../../../packages/engine-mars/src/fixtures/newcomer-layout.world-alternative.v2.json',import.meta.url),'utf8'));
  await accept(f.host,f.host.installCommonsNewcomerResourcesV1(layout.placements));await accept(f.host,f.host.installNativeSleepSnapshotV1());
  await accept(f.host,f.host.installEdenGroundV1());await accept(f.host,f.host.installEdenLectureV1(placement));
  for(const n of ['ana','ben']){await invite(f,n);await accept(f.host,f.souls.create('dev:'+n,{name:n,description:'Synthetic Eden resident'}));}
  run(f.host,60);f.host.saveSnapshot(true);run(f.host,20);
  const before=f.host.engine.rulesVersion;assert.doesNotMatch(before,REPAIR);assert.match(before,/\+eg\/1|\+l\/1/);
  f.host.stop();f.db.close();

  const keeper=async(db:Db,adopt=true)=>soulsRepairReaderV1(await edenHistoryFactory(db,f.host.worldId,{lifeV1:true,newcomerResourcesV1:true,sleepSnapshotV1:true,lectureV1:true,groundV1:true}),{adopt});
  let live:ReturnType<typeof head>;
  { const db=new Db(path),h=new WorldHost(db,await keeper(db),f.host.seed,1e9,f.host.worldId,{durableClockV1:true});assert.equal(h.boot().from,'snapshot');assert.equal(h.engine.rulesVersion,before);
    const fact=await accept(h,h.adoptSoulsRepairV1('operator:souls-repair-default'));assert.ok(fact);
    assert.equal(h.engine.rulesVersion.replace('+souls-repair/1',''),before);assert.match(db.world(h.worldId)!.rules_version,REPAIR);
    run(h,60);h.saveSnapshot(true);run(h,40);live=head(h);h.stop();db.close(); }
  for(const mode of ['snapshot','genesis']){
    if(mode==='genesis'){const db0=new Db(path);db0.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(f.host.worldId);db0.close();}
    const db=new Db(path),h=new WorldHost(db,await keeper(db),f.host.seed,1e9,f.host.worldId,{durableClockV1:true});
    assert.equal(h.boot().from,mode);assert.deepEqual(head(h),live,mode);
    assert.equal(await accept(h,h.adoptSoulsRepairV1('operator:souls-repair-default')),null,mode);
    assert.equal((db.db.prepare("SELECT count(*) n FROM events WHERE kind='rules' AND json_extract(payload,'$.soulsRepairAdoptV1.contract') IS NOT NULL").get() as {n:number}).n,1);
    h.stop();db.close();
  }
});
