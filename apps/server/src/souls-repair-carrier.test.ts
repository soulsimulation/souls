// #1323 probe: a REAL carrier step-out lands a rider inside a god-placed static (the Eden incident's shape: the balloon set
// Kino down inside the Reading Room). The rider is exempt from collision.human-static while carried, so the rule fires on
// the tick the step-out completes and `human.carrier` is deleted. Arm A: 4.16's rules (no repair) -> halt. Arm B: the
// repair rules adopted at the head before the step-out -> the clock runs; which rung handles it is printed, not asserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {marsFactory,GREEN_FIELD_WORLD,soulsRepairReaderV1} from '@souls/engine-mars';
import {fixture,invite,accept} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {mountEdgeRoutes} from './edge/routes.ts';
import {GodMode} from './god/god.ts';
import {installEngineBridge} from './god/engine-bridge.ts';
import {coreRef} from '@souls/world-compiler';
import {rot2} from '../../../mars/viewer/engine/core/math.ts';
import {carrierDef} from '../../../mars/viewer/engine/vehicles/carrier.ts';
import {rideKind} from './edge/comms/objects/ride.ts';

const old=await marsFactory({...GREEN_FIELD_WORLD,safeCrewRemoval:true});
const quiet=(t:any)=>{t.mock.method(console,'warn',()=>{});t.mock.method(console,'error',()=>{});t.mock.method(console,'log',()=>{});};

async function world(t:any,repair:boolean,settle=false){
  const f=fixture(':memory:',repair?soulsRepairReaderV1(old,{adopt:true}):old,{durableClockV1:true});f.brain.quiesce();f.souls.enableLifecycle();
  t.after(()=>{f.host.stop();f.db.close();});
  const host=f.host;
  if(repair){const fact=await accept(host,host.adoptSoulsRepairV1('test'));assert.ok(fact,'adopted');assert.match(host.engine.rulesVersion,/\+souls-repair\/1/);}
  if(settle)await accept<unknown>(host,host.enableRefusalSettleV1('test'));   // #1334 hold-settle/1, as boot adopts it
  const edge=new EdgeLedger(host,f.db,undefined,{ambient:false,sharedCarry:false}),app=new Hono();
  const comms=mountEdgeRoutes(app,{host,db:f.db,souls:f.souls,ledger:edge,soul:()=>null as any});t.after(()=>comms.close());
  const god=new GodMode(f.db,{worldId:host.worldId,ownerId:'dev:admin',tick:()=>host.engine.world.tick,emit(){}});
  installEngineBridge({host,god,edge,log(){},worldLore:false,worldClock:false} as any);
  const halted=()=>!host.clockAvailable||host.paused;
  const run=async(n:number,until:()=>boolean=()=>false)=>{for(let i=0;i<n&&!halted()&&!until();i++){host.tickOnce();if(i%10===0)await setImmediate();if(!halted())host.drainInputs();}return until();};
  await run(5);
  const souls:Record<string,{soulId:string;entityId:string}>={};
  for(const name of ['Kino','Ada']){await invite(f,name.toLowerCase());const row:any=await accept(host,f.souls.create(`dev:${name.toLowerCase()}`,{name,description:'Carrier probe'}));souls[name]={soulId:row.id,entityId:row.entity_id};}
  await run(30);
  const E=()=>(host.engine.world as any).entities,{Kino,Ada}=souls,[x,,z]=E()[Kino.entityId].pose.p;
  const at:[number,number]=[x+16,z],yaw=Math.PI;
  await accept<unknown>(host,host.installCarrierV1({id:'eden-balloon',def:'hot-air-balloon',label:'Red balloon',at,yaw,route:'commons-hop',waitSeconds:600} as any));
  comms.objects.create({id:'ride-eden-balloon',kind:'ride',name:'Red balloon',placeId:'world',params:{carrier:'eden-balloon'}});
  assert.notEqual(god.act({ops:[{op:'place',def:'core/zone@1',name:'yard',shape:{area:[[x-26,z-2],[x-22,z-2],[x-22,z+2],[x-26,z+2]]}}]} as any).accepted,false);
  await run(10);
  return {f,host,edge,god,comms,run,halted,E,Kino,Ada,balloon:()=>E()['eden-balloon']};
}

// the cottage is building/1: it enters physics as thin wall segments and closed doors (entity-physics.ts), as Eden's library did
const COTTAGE={w:8,d:6,floors:1,floorHeight:2.8,style:'cottage',roof:'gable',roofPitch:32,material:'plaster',front:'s',porch:0,balcony:false,windows:0.6,wallThickness:0.22};
for(const obstacle of ['table','walls'] as const)for(const [repair,settle] of [[false,false],[true,false],[true,true]] as const)
test(`a real balloon landing steps its rider out into ${obstacle==='table'?'a god-placed table':'the east wall of a god-built cottage it landed inside'}: ${settle?'C repair rules and hold-settle/1':repair?'B repair rules adopted':'A 4.16 rules'}`,{timeout:600000},async t=>{
  quiet(t);
  // both arms board as before #1324: no `clear: 'step-out/1'` (a rider who boarded before it, as Eden's did), so the
  // step-out goes into the wall; A shows 4.16 halting on it, B the repair rules handling it. #1324's clear step-out is ride-landing.test.ts's
  {const join=rideKind.actions.join,orig=join.apply.bind(join);t.mock.method(join,'apply',(s:any,p:any,ctx:any)=>{const out:any=orig(s,p,ctx);for(const b of out.bodies??[])for(const st of b.steps)if(st.verb==='mars:carrier_ride')delete st.params.clear;return out;});}
  const w=await world(t,repair,settle),{host,edge,god,run,halted,E,Kino,Ada}=w,act=(s:any,name:string,owner:string,cap:string)=>accept(host,edge.act({...s,name,owner} as any,{capability:cap}) as Promise<any>);
  const j=await act(Kino,'Kino','dev:kino','object:ride-eden-balloon:join');assert.notEqual(j.accepted,false,JSON.stringify(j));
  assert.ok(await run(3000,()=>E()[Kino.entityId].human?.carrier?.phase==='seated'),'Kino seated: '+JSON.stringify(E()[Kino.entityId].human?.carrier));
  const b=w.balloon(),home=[...b.pose.p],slot=E()[Kino.entityId].human.carrier.slot,seat=carrierDef(b)!.seats.find(s=>s.id===slot)!,d=rot2(seat.exit,b.pose.yaw);
  const exit:[number,number]=[home[0]+d[0],home[2]+d[1]];
  const st=await act(Kino,'Kino','dev:kino','object:ride-eden-balloon:start');assert.notEqual(st.accepted,false,JSON.stringify(st));
  assert.ok(await run(400,()=>w.balloon().carrier.phase==='aloft'&&w.balloon().pose.p[1]>3),'lifted off');
  // while it flies, a god puts a table on this seat's exit spot at home (as the library's walls stood where Kino stepped out)
  // a god's edit over the basket's ground footprint while it flies would take the rider out (see the report): place it once
  // the basket is clear of the building's footprint, on the far leg of the route
  if(obstacle==='walls')assert.ok(await run(1200,()=>{const p=w.balloon().pose.p;return p[0]-home[0]>3||Math.abs(p[2]-home[2])>4;}),'basket clear of the footprint');
  assert.equal(E()[Kino.entityId].human?.carrier?.phase,'seated','Kino still aboard before the edit');
  // walls: the basket lands inside the room, and this seat's exit spot is on the east wall's centre line
  const room={c:[exit[0]-COTTAGE.w/2+COTTAGE.wallThickness/2,home[2]] as [number,number],hx:COTTAGE.w/2,hz:COTTAGE.d/2};
  const placed=obstacle==='table'?god.act({ops:[{op:'place',def:'core/table@1',name:'reading-table',p:exit}]} as any):god.act({ops:[{op:'place',def:coreRef('cottage'),name:'reading-room',p:room.c,r:0,params:COTTAGE}]} as any);
  assert.notEqual(placed.accepted,false,JSON.stringify(placed));
  await run(20);
  // a durable baseline after every decision so far, as Eden had (its latest snapshot postdated the steer)
  host.saveSnapshot(true);
  // fly until shortly before the landing, then Ada sets off on a long walk that is under way at the step-out
  let lastPhase='';const trace:string[]=[];const watch=()=>{const bb=w.balloon(),kc=E()[Kino.entityId].human?.carrier,key=bb.carrier.phase+'/'+(kc?.phase??'none');if(key!==lastPhase){lastPhase=key;trace.push(`t${host.engine.world.tick} balloon ${bb.carrier.phase} ${bb.pose.p.map((v:number)=>v.toFixed(2))} Kino ${kc?.phase??'out'} ${E()[Kino.entityId].pose.p.map((v:number)=>v.toFixed(2))}`);}return false;};
  const route=1600;await run(route,()=>(watch(),w.balloon().carrier.phase!=='aloft'));
  console.info(`[probe ${obstacle} ${repair?'B':'A'}] flight trace: ${trace.join(' | ')}`);
  const wa=await act(Ada,'Ada','dev:ada','walk:yard');assert.notEqual(wa.accepted,false,JSON.stringify(wa));await run(2);
  const adaProg=host.engine.programOf(Ada.entityId);assert.ok(adaProg,'Ada walks');
  const seq0=host.seq,tick0=host.engine.world.tick;
  const stepped=await run(1200,()=>!E()[Kino.entityId].human?.carrier);
  const faultTick=host.engine.world.tick,k=()=>E()[Kino.entityId].pose.p,dist=()=>Math.hypot(k()[0]-exit[0],k()[2]-exit[1]);
  const table=[...god.model.entities.values()].find((e:any)=>e.name==='reading-table'||e.name==='reading-room') as any;
  const where=()=>{if(obstacle==='table')return '';const dx=Math.abs(k()[0]-room.c[0]),dz=Math.abs(k()[2]-room.c[1]),t=COTTAGE.wallThickness;return ` [cottage centre ${room.c.map(v=>v.toFixed(2))}, east wall centre line x=${exit[0].toFixed(2)}; Kino ${dx<room.hx-t&&dz<room.hz-t?'INSIDE the room':dx>room.hx+0.2||dz>room.hz+0.2?'OUTSIDE the building':'IN or AGAINST a wall'} (dx ${dx.toFixed(2)} of ${room.hx}, dz ${dz.toFixed(2)} of ${room.hz})]`;};
  console.info(`[probe ${obstacle} ${repair?'B':'A'}] home ${home.map(v=>v.toFixed(2))}, exit ${exit.map(v=>v.toFixed(2))}, table ${JSON.stringify(table?.p??table?.pose??null)}; balloon ${w.balloon().carrier.phase} and Ada walking (programme ${adaProg}) at tick ${tick0}; Ada's programme at the step-out tick ${host.engine.programOf(Ada.entityId)}; rider out=${stepped} at tick ${faultTick}; halted=${halted()}; Kino ${k().map((v:number)=>v.toFixed(2))} ${dist().toFixed(2)} m from the exit spot${where()}; glitches ${JSON.stringify(host.glitches)}`);
  if(!repair){
    await run(40);
    console.info(`[probe ${obstacle} A] after 40 ticks: halted=${halted()} tick ${host.engine.world.tick} glitches ${JSON.stringify(host.glitches)}`);
    assert.equal(halted(),true,'4.16 halts on the step-out');assert.ok(Object.keys(host.glitches.byRule).includes('collision.human-static'),JSON.stringify(host.glitches));
    return;
  }
  const adaAtFault=host.engine.programOf(Ada.entityId);
  await run(600);
  const later=host.db.db.prepare('SELECT seq,tick,author,payload FROM events WHERE world_id=? AND seq>? AND kind=\'rules\'').all(host.worldId,seq0).map((r:any)=>{const p=JSON.parse(r.payload);return {seq:r.seq,tick:r.tick,author:r.author,keys:Object.keys(p),refusal:p.refusal?{rule:p.refusal.rule,bodies:p.refusal.bodies,relocated:p.refusal.relocated,to:p.refusal.to,stuck:p.refusal.stuck}:undefined,recovery:p.recovery?{lastRung:p.recovery.lastRung??null,keys:Object.keys(p.recovery)}:undefined,inPlace:p.lastRungInPlace??undefined};});
  console.info(`[probe ${obstacle} B] rules rows from the step-out on: ${JSON.stringify(later).slice(0,4000)}`);
  console.info(`[probe ${obstacle} B] Ada's programme: started ${adaProg}, at the step-out ${adaAtFault}, now ${host.engine.programOf(Ada.entityId)}; Ada's terminal programme events ${JSON.stringify(host.db.db.prepare("SELECT tick,author,payload FROM events WHERE world_id=? AND seq>? AND payload LIKE ?").all(host.worldId,seq0,'%'+Ada.entityId+'%').map((r:any)=>({tick:r.tick,author:r.author,p:String(r.payload).slice(0,300)})))}, Ada at ${E()[Ada.entityId].pose.p.map((v:number)=>v.toFixed(2))}`);
  console.info(`[probe ${obstacle} B] after 600 more ticks: halted=${halted()} tick ${host.engine.world.tick}; Kino ${k().map((v:number)=>v.toFixed(2))} ${dist().toFixed(2)} m from the exit spot${where()}; standing violations ${JSON.stringify(host.engine.runtime.violations.filter((v:any)=>v.tick>=tick0))}; glitches ${JSON.stringify(host.glitches)}; rewinds ${host.rewinds}`);
  assert.equal(halted(),false,'the clock runs');assert.equal(adaAtFault,adaProg,'Ada was walking at the step-out');assert.ok(host.engine.world.tick>=faultTick+590,'600 ticks on');
  // rung 1 alone: the rider is relocated once, by a refusal row; nothing goes back, nobody else is stopped, nothing stands broken
  const rel=later.filter((r:any)=>r.refusal?.relocated&&r.refusal.bodies.includes(Kino.entityId));
  assert.equal(rel.length,1,'relocated once: '+JSON.stringify(later).slice(0,2000));assert.equal(rel[0].refusal!.rule,'collision.human-static');
  assert.ok(!later.some((r:any)=>r.recovery||r.inPlace),'no rung 2 or 3');assert.equal(host.rewinds,0,'no rewind');
  assert.deepEqual(host.engine.runtime.violations.filter((v:any)=>v.tick>=tick0+5),[],'nothing stands broken');
  assert.ok(!host.db.db.prepare("SELECT 1 FROM events WHERE world_id=? AND seq>? AND payload LIKE ? LIMIT 1").get(host.worldId,seq0,'%'+Ada.entityId+'%world.re%'),'Ada was never refused, relocated or rewound');
  if(obstacle==='walls')assert.ok(Math.abs(k()[0]-room.c[0])>room.hx+COTTAGE.wallThickness/2||Math.abs(k()[0]-room.c[0])<room.hx-COTTAGE.wallThickness/2-0.15,'clear of the east wall');
  else assert.ok(dist()>0.6,'clear of the table');
});
