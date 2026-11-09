// Edge: several Souls swim at once; a crossing body never fails a swim receipt with occupied-route.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {setImmediate} from 'node:timers/promises';
import {retainedCommonsShoreFactory,nativeSleepSnapshotFactoryV1} from '@souls/engine-mars';
import type {WorldState as NativeWorld} from '../../../mars/viewer/engine/world/types.ts';
import {fixture,invite,accept} from '../test/native-owner-fixture.ts';
import {LivingWorld} from './living.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
/** policy: force every swim step to this shared-water-wait policy (the server writes /3), or drop it (null), to prove the others unchanged.
 * cycle: bounds on the longest mutual wait, and whether a gate-cycle yield must (or must not) be logged. */
async function fourSwims(t:any,birthIds?:string[],refused=false,o:{policy?:string|null;cycle?:{maxTicks?:number;minTicks?:number;yields:boolean};outcome?:[string,string|null][];replay?:[number,number]}={}){
 const factory=nativeSleepSnapshotFactoryV1(await retainedCommonsShoreFactory()),f=fixture(':memory:',factory,{durableClockV1:true});f.souls.enableLifecycle();f.brain.quiesce();t.after(()=>{f.host.stop();f.db.close();});
 await accept<unknown>(f.host,new LivingWorld(f.host).install(['Owners drive their Souls.']));for(let i=0;i<4;i++)f.host.tickOnce();
 await accept(f.host,f.host.installCommonsProvisionsV1());await accept(f.host,f.host.installRetainedCommonsShoreV1());
 await accept<unknown>(f.host,f.host.enableQuietStallReleaseV1());await accept<unknown>(f.host,f.host.enableYieldTimeoutV1());await accept<unknown>(f.host,f.host.enableShoreDepartV1());
 const rows:any[]=[];for(const [i,n]of ['ana','ben','cy','di'].entries()){await invite(f,n);if(!birthIds){rows.push(await accept(f.host,f.souls.create('dev:'+n,{name:n,description:'edge swimmer'})));continue;}
  // Reproduce the ACTUAL failed tuple through normal Souls.create/birth. Only
  // five-byte Soul ID randomness is pinned; all motion/collision checks remain.
  const original=crypto.randomBytes;let calls=0;const stub=t.mock.method(crypto,'randomBytes',(...args:any[])=>{if(args[0]===5){assert.equal(++calls,1);return Buffer.from(birthIds[i].slice(2),'hex');}return (original as any)(...args);});syncBuiltinESMExports();
  try{rows.push(await accept(f.host,f.souls.create('dev:'+n,{name:n,description:'edge swimmer'})));assert.equal(rows[i].id,birthIds[i]);}finally{stub.mock.restore();syncBuiltinESMExports();}
 }
 const ledger=new EdgeLedger(f.host,f.db),souls=rows.map(r=>({soulId:r.id,entityId:r.entity_id,name:r.name,owner:r.owner}));
 t.diagnostic('swimmer identities '+JSON.stringify(souls.map(s=>({soulId:s.soulId,entityId:s.entityId}))));
 const native=(f.host.engine as any).rt;if(birthIds){const cancel=native.cancel.bind(native);t.mock.method(native,'cancel',(id:string,why:any)=>{if(why?.code==='route.blocked')t.diagnostic('before safe cancel '+JSON.stringify({id,tick:native.tick,records:[...native.records.values()].filter((r:any)=>r.id===id||r.parent===id).map((r:any)=>({id:r.id,parent:r.parent,verb:r.verb,status:r.status,phase:r.phase,diagnostic:r.diagnostic})),waits:[...(native.services.moverWaits?.samples.values()??[])].map((r:any)=>({mover:r.mover,owner:r.owner,blockers:r.blockers,code:r.code,tick:r.tick}))}));return cancel(id,why);});}
 if(o.policy!==undefined){const perform=f.host.engine.perform.bind(f.host.engine);t.mock.method(f.host.engine,'perform',(p:any)=>{p=structuredClone(p);for(const s of p.steps??[])if(s.params?.spreadWaitPolicy){if(o.policy===null)delete s.params.spreadWaitPolicy;else s.params.spreadWaitPolicy=o.policy;}return perform(p);});}
 const receipts:string[]=[];for(const s of souls){const r=await accept(f.host,ledger.act(s,{capability:'swim:shore-water'}));assert.equal(r.accepted,true,JSON.stringify(r));if(r.accepted)receipts.push(r.receipt.id);}
 const w=f.host.engine.world as NativeWorld;let peak=0;
 const done=()=>receipts.every((id,i)=>!['waiting','started'].includes(ledger.receipt(souls[i].soulId,id)!.phase));
 // #1291: the longest unbroken run of ticks in which some swimmer's live record is held in a mutual wait (deadlock.cycle or
 // walk.goal-occupied), and every gate-cycle yield seen (the logged cancel code)
 const ids=new Set(souls.map(s=>s.entityId)),rt=(f.host.engine as any).rt,yields=new Set<string>();let held=0,longest=0,copy:any,replayed=0;
 for(let i=0;i<20000&&!done();i++){f.host.tickOnce();if(i%20===0)await setImmediate();peak=Math.max(peak,souls.filter(s=>['swim','tread'].includes(String(w.entities[s.entityId].human?.activity))).length);
  // replay: a snapshot taken before the window restores and steps state-hash identical through it (the gate-cycle yield included)
  if(o.replay&&w.tick===o.replay[0])copy=factory.restore(f.host.engine.snapshot());else if(copy&&w.tick<=o.replay![1]){copy.step();assert.equal(copy.stateHash(),f.host.engine.stateHash(),'replay diverged at tick '+w.tick);replayed=w.tick;}
  if(o.cycle){let now=false;for(const r of rt.records.values()){if(!ids.has(r.params?.actor))continue;const c=r.diagnostic?.code;if(c==='shore.cycle-yield')yields.add(r.id);else if(rt.isActive(r.id)&&(c==='deadlock.cycle'||c==='walk.goal-occupied'))now=true;}held=now?held+1:0;longest=Math.max(longest,held);}}
 if(o.replay)assert.equal(replayed,o.replay[1],'the replay window was stepped');
 if(o.cycle){t.diagnostic('longest mutual wait '+longest+' ticks, gate-cycle yields '+yields.size);
  if(o.cycle.maxTicks!==undefined)assert.ok(longest<=o.cycle.maxTicks,'longest mutual wait '+longest+' ticks');if(o.cycle.minTicks!==undefined)assert.ok(longest>=o.cycle.minTicks,'longest mutual wait '+longest+' ticks');
  assert.equal(yields.size>0,o.cycle.yields,'gate-cycle yields '+yields.size);
 }
 const final=receipts.map((id,i)=>ledger.receipt(souls[i].soulId,id));
 const engine=f.host.engine as any;
 t.diagnostic('swim final diagnostics '+JSON.stringify({tick:w.tick,peak,receipts:final,programs:[...engine.programs.values()].filter((p:any)=>souls.some(s=>s.entityId===p.actor)).map((p:any)=>({id:p.id,actor:p.actor,index:p.index,status:p.status,spreadWaits:p.spreadWaits,steps:p.steps,diagnostic:p.diagnostic})),records:[...engine.runtime.records.values()].filter((r:any)=>souls.some(s=>s.entityId===(r.params as any)?.actor)&&/shore|walk_to/.test(r.verb)).map((r:any)=>({id:r.id,verb:r.verb,status:r.status,phase:r.phase,params:r.params,diagnostic:r.diagnostic,history:r.history}))}));
 if(o.outcome){assert.deepEqual(final.map(r=>[r!.phase,r!.code]),o.outcome);assert.deepEqual(f.host.engine.runtime.violations,[]);return;}
 if(refused){
  // #1291: shared-water-wait/2 keeps this exact outcome (the refusal is honest and the Soul ends free); /3 resolves it.
  assert.deepEqual(final.map(r=>[r!.phase,r!.code]),[['failed','shore.occupied-route'],['completed',null],['completed',null],['completed',null]]);
  assert.equal(final[0]!.endedTick,1981,'the /2 path ends at the same tick as before /3');assert.match(final[0]!.reason??'',/must wait for/);assert.deepEqual(ledger.openReceipts(souls[0].soulId),[]);
  assert.equal(engine.programOf(souls[0].entityId),null);assert.ok(!['swim','tread'].includes(String(w.entities[souls[0].entityId].human?.activity)));
  assert.deepEqual(f.host.engine.runtime.violations,[]);return;
 }
 assert.deepEqual(final.map(r=>r!.phase),['completed','completed','completed','completed'],JSON.stringify(final.map(r=>[r!.phase,r!.code])));
 assert.ok(peak>=3,'peak '+peak);assert.deepEqual(f.host.engine.runtime.violations,[]);assert.equal(f.db.paidCost(),0);
 t.diagnostic('peak simultaneous swimmers '+peak);
}
// #1291: pinned, because a random draw can land on a set where one swim is refused (below): that made this test fail by chance
test('four edge swims at once all complete; peak simultaneous swimmers >= 3',{timeout:300000},async t=>fourSwims(t,['s_a1b2c3d4e5','s_0f1e2d3c4b','s_5a6b7c8d9e','s_e5d4c3b2a1']));
// #1291: on this set two swimmers lock at the shore gate (deadlock.cycle) and a third waits behind them. Under /2 the
// lock lasts about 115 s and the third swim fails; /3's gate-cycle yield frees the lock and the parked-only budget keeps the third waiting.
test('#1291 under shared-water-wait/2 this set still refuses one swim shore.occupied-route after a long wait, and that Soul ends free',{timeout:300000},async t=>fourSwims(t,['s_8a2bc731f9','s_e066ece6c6','s_eb878d9395','s_d78ac3585a'],true,{policy:'shared-water-wait/2',cycle:{minTicks:1000,yields:false}}));
// Bound: no swimmer stays in a mutual wait for more than 15 s (300 ticks): 10 s for the runtime to publish the cycle, then the step aside.
test('#1291 under shared-water-wait/3 this set completes all four swims and its gate cycle resolves within 15 s',{timeout:300000},async t=>fourSwims(t,['s_8a2bc731f9','s_e066ece6c6','s_eb878d9395','s_d78ac3585a'],false,{cycle:{maxTicks:300,yields:true},replay:[900,1400]}));
test('captured connected-gate failure tuple completes all four real swim receipts',{timeout:300000},async t=>fourSwims(t,['s_97bcc2b8d7','s_c0fd670f18','s_8eed8dee09','s_fe091e7358']));
test('captured connected-water child failure tuple completes all four real swim receipts',{timeout:300000},async t=>fourSwims(t,['s_15651a5250','s_deb97f53b3','s_7cfa396701','s_6bafe7feea']));
test('captured dry-child current wait evidence',{timeout:300000},async t=>fourSwims(t,['s_cfab80d090','s_a4e2f51728','s_6997c43e88','s_fa16b5dfe1']));
test('captured occupied-route failure tuple (Modal n2 5ac841e9) completes all four real swim receipts',{timeout:300000},async t=>fourSwims(t,['s_9a2b2272bf','s_52c1e0a87c','s_b659127058','s_2e5d8ae1bf']));
// Two swimmers stopped touching a third on the dry gate; without shoreDepartV1 each step away was occupied for good and
// three receipts failed shore.occupied-route (deterministic with these IDs before the policy).
test('captured gate-departure failure tuple (Modal r13 a34d4b8d9) completes all four real swim receipts',{timeout:300000},async t=>fourSwims(t,['s_94b5b3be42','s_c53217e44c','s_cc9df835c7','s_01c1f66bdf']));
// #1291: the gate-cycle yield is for /3 swim steps only. The same walks with no wait policy keep the long native lock (the old
// minute-long walk timeouts break it), log no yield, and end as they always have without a wait policy (three refused).
test('#1291 the same set with no wait policy keeps its long gate lock and logs no gate-cycle yield',{timeout:300000},async t=>fourSwims(t,['s_8a2bc731f9','s_e066ece6c6','s_eb878d9395','s_d78ac3585a'],false,{policy:null,cycle:{minTicks:1000,yields:false},outcome:[['failed','shore.occupied-route'],['failed','shore.occupied-route'],['failed','shore.occupied-route'],['completed',null]]}));
