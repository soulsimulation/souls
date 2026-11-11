// #2051 (replaces PM-R055b's resume): every act in flight at a restart ends when the ledger opens, before the world
// serves a request: failed `receipt.lost-on-restart`, its programme stopped. A receipt that already ended is kept as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {retainedCommonsShoreFactory,nativeSleepSnapshotFactoryV1,COMMONS_PERSONAL_RESOURCES} from '@souls/engine-mars';
import {Db} from './db.ts';
import {WorldHost} from './world.ts';
import {fixture,invite,accept} from '../test/native-owner-fixture.ts';
import {LivingWorld} from './living.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
const factory=nativeSleepSnapshotFactoryV1(await retainedCommonsShoreFactory());
test('restart: in-flight receipts end at boot with a named reason; finished ones are untouched (clean close)',{timeout:300000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'edge-restart-receipts-')),path=join(dir,'sim.db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const f=fixture(path,factory,{durableClockV1:true});f.souls.enableLifecycle();f.brain.quiesce();
 await accept<unknown>(f.host,new LivingWorld(f.host).install(['Owners drive their Souls.']));for(let i=0;i<4;i++)f.host.tickOnce();
 await accept(f.host,f.host.installCommonsProvisionsV1());await accept(f.host,f.host.installRetainedCommonsShoreV1());await accept(f.host,f.host.installNativeSleepSnapshotV1());
 await accept<unknown>(f.host,f.host.enableContinuousDayV1());   // runtime-policy cfg facts would need the history-aware factory to restore
 const rows:any[]=[];for(const n of ['ana','ben']){await invite(f,n);rows.push(await accept(f.host,f.souls.create('dev:'+n,{name:n,description:'restart receipts'})));}
 const [ana,ben]=rows.map(r=>({soulId:r.id,entityId:r.entity_id,name:r.name,owner:r.owner}));
 let ledger=new EdgeLedger(f.host,f.db);
 const run=async(h:WorldHost,n:number,until=()=>false)=>{for(let i=0;i<n&&!until();i++){h.tickOnce();if(i%20===0){await setImmediate();h.drainInputs();}}};
 // Cara: a short act that completes before the restart. Ana: a long rest, started. Ben: asleep, then an act -> waiting.
 const cara=await invite(f,'cara').then(()=>accept(f.host,f.souls.create('dev:cara',{name:'cara',description:'restart receipts'}))) as any;
 const C={soulId:cara.id,entityId:cara.entity_id,name:cara.name,owner:cara.owner};
 const c=await accept(f.host,ledger.act(C,{capability:'rest:here',params:{seconds:5}}));const cid=(c as any).receipt.id;
 await run(f.host,400,()=>ledger.receipt(C.soulId,cid)!.phase==='completed');assert.equal(ledger.receipt(C.soulId,cid)!.phase,'completed','Cara finished before the restart');
 const a=await accept(f.host,ledger.act(ana,{capability:'rest:here',params:{seconds:120}}));const aid=(a as any).receipt.id;
 await run(f.host,60,()=>ledger.receipt(ana.soulId,aid)!.phase==='started');assert.equal(ledger.receipt(ana.soulId,aid)!.phase,'started');
 // Dee: a started act whose bound hand-contact effect already landed (its row carries contactAppliedV1, as contactTicks
 // writes it mid-programme): committed, so it must end completed, not refused.
 const dee=await invite(f,'dee').then(()=>accept(f.host,f.souls.create('dev:dee',{name:'dee',description:'restart receipts'}))) as any;
 const D={soulId:dee.id,entityId:dee.entity_id,name:dee.name,owner:dee.owner};
 const d=await accept(f.host,ledger.act(D,{capability:'rest:here',params:{seconds:120}}));const did=(d as any).receipt.id;
 await run(f.host,60,()=>ledger.receipt(D.soulId,did)!.phase==='started');assert.equal(ledger.receipt(D.soulId,did)!.phase,'started');
 f.db.db.prepare("UPDATE edge_receipts_v1 SET detail=json_set(COALESCE(detail,'{}'),'$.contactAppliedV1',json('true')) WHERE receipt_id=?").run(did);
 await accept(f.host,f.host.enqueue('decision','fixture:sleep',{soulId:ben.soulId,entityId:ben.entityId,option:'sleep',label:'sleep on own mat',steps:[{verb:'mars:sleep',params:{mat:'commons-mat-2',duration:600,returnTo:COMMONS_PERSONAL_RESOURCES[1].sleepReturn}}],reevalTicks:1e9,fallback:false,trigger:'fixture'}));
 const W=f.host.engine.world as any;await run(f.host,3000,()=>W.entities[ben.entityId].human?.sleepPose?.standingFraction===0);assert.equal(W.entities[ben.entityId].human?.sleepPose?.standingFraction,0,'Ben asleep');
 const b=await accept(f.host,ledger.act(ben,{capability:'rest:here',params:{seconds:5}}));const bid=(b as any).receipt.id;
 const wasWaiting=ledger.receipt(ben.soulId,bid)!.phase==='waiting';
 // Clean close exactly as edge-server does: stop the clock, drain, snapshot.
 f.host.stop();f.host.drainInputs();assert.ok(f.host.engine.canSnapshot?.()!==false,'snapshot carries in-flight work');f.host.saveSnapshot(true);
 const worldId=f.host.worldId,seed=f.host.seed;f.db.close();
 const db=new Db(path),h=new WorldHost(db,factory,seed,1e9,worldId,{durableClockV1:true});h.boot();h.drainInputs();t.after(()=>{h.stop();if(db.db.isOpen)db.close();});
 ledger=new EdgeLedger(h,db);
 // The bound: terminal when the ledger opens (no tick has run, nothing has been served).
 const tick=h.engine.world.tick;
 // ledger.receipt is what GET /v1/edge/receipts/:id answers, so a client `wait` on the receipt returns this phase at once.
 for(const [s_,id] of [[ana.soulId,aid],[ben.soulId,bid]] as const){const r=ledger.receipt(s_,id)!;
  assert.equal(r.phase,'failed',JSON.stringify(r));assert.equal(r.code,'receipt.lost-on-restart');assert.equal(r.endedTick,tick,'ended at boot, before any tick');}
 assert.ok(wasWaiting,'the scenario exercised a waiting receipt');
 // Nothing that committed is reported as refused.
 assert.equal(ledger.receipt(C.soulId,cid)!.phase,'completed','a finished act stays completed');
 assert.equal(ledger.receipt(D.soulId,did)!.phase,'completed','an act whose contact effect landed ends completed');
 // A listener that subscribes before the first tick (the event stream a client `wait` long-polls) is handed the endings.
 const seen=new Map<string,string>();ledger.onReceipt(r=>seen.set(r.id,r.phase));
 assert.deepEqual([seen.get(aid),seen.get(bid),seen.get(did)],['failed','failed','completed'],'boot endings reach a later subscriber');
 // The resumed rest's programme is stopped (logged edge-stop): Ana's body is free within a second of ticks.
 await run(h,40,()=>!h.engine.programOf(ana.entityId));assert.equal(h.engine.programOf(ana.entityId),null,'programme stopped');
 // And her next act is accepted.
 const next=await accept(h,ledger.act(ana,{capability:'wave:here',params:{}}));assert.ok((next as any).receipt?.id,JSON.stringify(next));
});
