// #1952 wait-bound/1: a walk that is going nowhere ends within a minute. `traffic.yield` pauses the walk watchdog, and the
// persistent-wait detector restarts whenever the waiting body moves by a millimetre, which a walker yielding beside a wall
// does every few ticks (its yield offset is clipped by the wall's clearance). Such a walk never ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,type MarsEngine} from './engine.ts';
import {loadMars} from './load.ts';
import {regionSlots} from '../../../mars/viewer/engine/social/slots.ts';
import type {ProgramEvent} from '@souls/engine-contract';

// The proving ground: a 1.0 m single-file passage at x=15 in a wall along z=-15.
const factory=await marsFactory();
const B='h_block0000',W='h_walker000';
const execOf=(e:MarsEngine,actor:string):any=>[...((e as any).rt.services.walkExecs?.values()??[])].find((x:any)=>x.actor===actor);

function yieldBesideWall(policy:Record<string,boolean>={}){
  const e=factory.create(factory.genesis('wait-bound')) as MarsEngine;
  e.configureRuntimePolicy({sleepBlockTicks:1200,...policy} as never);
  e.spawnHuman({id:B,soul:'s_'+B,label:'Blocker',near:{at:[15,-14.8],first:true}});
  e.spawnHuman({id:W,soul:'s_'+W,label:'Walker',near:{at:[19,-17],first:true}});
  assert.deepEqual([e.world.entities[B].pose.p,e.world.entities[W].pose.p],[[15,0,-14.8],[19,0,-17]],'both bodies stand where the scene puts them');
  const r=e.perform({actor:W,label:'through the passage',steps:[{verb:'mars:walk_to',params:{x:14.8,z:-10}}]});assert.equal(r.ok,true,JSON.stringify(r));
  return {e,id:r.id!};
}
/** Steps the scene. The blocker stands in the passage holding it, as a walker inside it would, and never leaves. */
function run(e:MarsEngine,ticks:number){
  const rt=(e as any).rt,events:ProgramEvent[]=[],actions=new Set<string>();
  // headway: the last tick the walker's body left a 0.5 m disc round where it last made headway (the watchdog's measure)
  let held=false,firstBlocked:number|undefined,rocks=0,last:number[]|undefined,anchor=[...e.world.entities[W].pose.p],headway=e.world.tick;
  for(let i=0;i<ticks;i++){
    events.push(...e.step().programs);
    const ex=execOf(e,W);
    if(ex&&!held&&ex.narrows.length){const n=ex.narrows[0];(rt.services.traffic??=new Map()).set(n.res,{actors:new Set([B]),entry:n.entry,dir:[-n.dir[0],-n.dir[1]]});held=true;}
    const rec=ex?rt.records.get(ex.id):undefined,p=e.world.entities[W].pose.p;
    if(ex)actions.add(ex.id);
    if(rec?.status==='blocked'){firstBlocked??=e.world.tick;if(last&&Math.hypot(p[0]-last[0],p[2]-last[2])>0.001)rocks++;}
    last=[...p];
    if(Math.hypot(p[0]-anchor[0],p[2]-anchor[2])>0.5){anchor=[...p];headway=e.world.tick;}
  }
  return {events,firstBlocked,rocks,actions,headway};
}

test('#1952 A1 without wait-bound/1: a walker yielding beside a wall rocks and is still walking past 1,200 ticks',()=>{
  const {e,id}=yieldBesideWall(),{events,firstBlocked,rocks}=run(e,1500);
  assert.ok(firstBlocked!==undefined&&firstBlocked<200,'the walker yields at the passage');
  assert.ok(rocks>1000,`the waiting body moves more than 1 mm on most ticks (${rocks})`);
  assert.equal(e.programOf(W),id,'still walking');assert.equal(events.some(x=>x.id===id&&x.kind!=='step'),false);
  const rec=(e as any).rt.records.get(execOf(e,W).id);assert.equal(rec.status,'blocked');assert.equal(rec.diagnostic.code,'traffic.yield');
});

test('#1952 A1/A2 wait-bound/1: the same walk ends route.blocked within 1,200 ticks of stopping and names the body it waited for',()=>{
  const {e,id}=yieldBesideWall({waitBoundV1:true}),{events,headway}=run(e,1500);
  const failed=events.filter(x=>x.id===id&&x.kind==='failed');assert.equal(failed.length,1);
  assert.equal(failed[0].code,'route.blocked');assert.match(failed[0].message!,/wait-bound\/1/);assert.match(failed[0].message!,new RegExp(`traffic\\.yield.*${B}`));
  assert.ok(failed[0].tick>=headway+1199&&failed[0].tick<=headway+1201,`ended at ${failed[0].tick}, last headway at ${headway}`);
  assert.equal(e.programOf(W),null);assert.equal(execOf(e,W),undefined,'nothing left behind');assert.deepEqual(e.runtime.violations,[]);
});

test('#1952 A2 wait-bound/1 counts per programme step: step-backs (edge motion) re-issue the walk and do not extend it',()=>{
  const off=yieldBesideWall({edgeMotionV1:true}),offRun=run(off.e,1500);
  assert.ok(offRun.actions.size>1,'the walker stepped back and tried again');
  const {e,id}=yieldBesideWall({edgeMotionV1:true,waitBoundV1:true}),{events,headway,actions}=run(e,1500);
  assert.ok(actions.size>1,'the walk was re-issued');
  const failed=events.filter(x=>x.id===id&&x.kind==='failed');assert.equal(failed.length,1);assert.match(failed[0].message!,/wait-bound\/1/);
  assert.ok(failed[0].tick>=headway+1199&&failed[0].tick<=headway+1201,`ended at ${failed[0].tick}, last headway at ${headway}`);
  const offEnd=offRun.events.find(x=>x.id===off.id&&x.kind==='failed');assert.ok(!offEnd||offEnd.tick>failed[0].tick,'without the bound the step-backs ran longer');
});

test('#1952 A2 wait-bound/1 is a named state-hash input',()=>{
  const off=factory.create(factory.genesis('wait-bound-hash')) as MarsEngine,on=factory.create(factory.genesis('wait-bound-hash')) as MarsEngine;
  on.configureRuntimePolicy({sleepBlockTicks:1200,waitBoundV1:true} as never);off.configureRuntimePolicy({sleepBlockTicks:1200} as never);
  assert.notEqual(on.stateHash(),off.stateHash());
});

test('#1952 A3 a body blocked on a stair flight is not ended by wait-bound/1',async()=>{
  // Hypothetical native fixture (walk-block.test.ts): a reserved standing slot holds the far landing, so the climber waits on the flight.
  const f=await marsFactory(EDEN_SAFE_COMMONS_WORLD),m=await loadMars(),w=f.genesis('wait-bound-flight'),z=-1.7;
  const region={id:'hold',label:'Hypothetical landing hold',provenance:{origin:'test-fixture' as const,confidence:'hypothetical' as const},kind:'place' as const,level:1,polygon:[[8.9,z-1.01],[9.1,z-1.01],[9.1,z+1],[8.9,z+1]] as [number,number][],layout:{focus:[9,1] as [number,number],kind:'stand' as const}};
  (w.regions as any).hold=region;
  const rt0=new m.Runtime(w,m.createRegistry(),m.servicesFor(m.scenes)(w),m.invariants);
  const slot=regionSlots(rt0,region as any).find(s=>Math.abs(s.p[1]-z)<1e-9)!;assert.ok(slot);
  w.entities.blocker=m.human('blocker',slot.p[0],slot.p[1],{level:1,y:.24,yaw:slot.yaw});w.entities.walker=m.human('walker',9,.8,{yaw:-Math.PI/2});
  const e=f.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,waitBoundV1:true} as never);
  const hold=e.submit('take_slot',{actor:'blocker',slot:slot.id});for(let i=0;i<20;i++)e.step();assert.equal(hold.phase,'occupied');
  const r=e.perform({actor:'walker',label:'walk onto presentation deck',steps:[{verb:'walk_to',params:{to:'commons-deck',standoff:0}}]});assert.equal(r.ok,true);
  let firstBlocked:number|undefined;
  for(let i=0;i<1500&&(firstBlocked===undefined||e.world.tick<firstBlocked+1300);i++){
    e.step();const ex=execOf(e,'walker'),rec=ex?e.runtime.records.get(ex.id):undefined;
    if(rec?.status==='blocked'&&firstBlocked===undefined){firstBlocked=e.world.tick;assert.equal(ex.phase,'climb','blocked on the flight');}
  }
  assert.ok(firstBlocked!==undefined&&e.world.tick>=firstBlocked+1300);
  const ex=execOf(e,'walker');assert.equal(ex.phase,'climb');assert.equal(ex.cancelTo,undefined,'no stop was asked of the climber');
  assert.equal((e as any).rt.isCancelling(ex.id),false);assert.equal(e.programOf('walker'),r.id);assert.deepEqual(e.runtime.violations,[]);
});

test('#1952 A4 under wait-bound/1 a forced cancel and a normal release both remove the walk exec',()=>{
  for(const policy of [false,true]){
    const forced=yieldBesideWall(policy?{waitBoundV1:true}:{});run(forced.e,120);
    const fx=execOf(forced.e,W);assert.ok(fx);(forced.e as any).rt.forceCancel(fx.id,{code:'stall.released',message:'test release'});
    assert.equal((forced.e as any).rt.isActive(fx.id),false);
    assert.equal(execOf(forced.e,W)!==undefined,!policy,policy?'forceCancel leaves no walk exec':'without the policy the old leak stays (replays keep their bytes)');
    const normal=yieldBesideWall(policy?{waitBoundV1:true}:{});run(normal.e,120);
    const nx=execOf(normal.e,W);assert.ok(nx);(normal.e as any).rt.cancel(nx.id,{code:'route.blocked',message:'test release'});
    assert.equal((normal.e as any).rt.isActive(nx.id),false);assert.equal(execOf(normal.e,W),undefined,'a normal release leaves no walk exec');
  }
});

// #2032 A1: a body held at a flight's foot (phase `climb`, climbT 0) is not on the flight. Hypothetical native fixture: a body
// standing on the ground beside the deck flight's foot is within reach of the climber's first step, and its own way out is
// held by the climber (deadlock.cycle), the case behind one frozen walk in #2001's counted playtest.
test('#2032 A1 wait-bound/1 ends a walk held at a flight foot through its normal cancel, the body where it stood',async()=>{
  const f=await marsFactory(EDEN_SAFE_COMMONS_WORLD),m=await loadMars(),w=f.genesis('wait-bound-foot');
  w.entities.beside=m.human('beside',9.5,-.6,{yaw:Math.PI/2});w.entities.walker=m.human('walker',9,.8,{yaw:-Math.PI/2});
  const e=f.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,waitBoundV1:true} as never);
  e.step();assert.deepEqual(e.runtime.violations,[],'both bodies stand clear');
  const r=e.perform({actor:'walker',label:'walk onto presentation deck',steps:[{verb:'walk_to',params:{to:'commons-deck',standoff:0}}]});assert.equal(r.ok,true,JSON.stringify(r));
  const events:ProgramEvent[]=[];let atFoot:number|undefined,footPose:number[]|undefined,anchor=[...e.world.entities.walker.pose.p],headway=e.world.tick;
  for(let i=0;i<1600&&e.programOf('walker');i++){
    events.push(...e.step().programs);
    const ex=execOf(e,'walker'),rec=ex?e.runtime.records.get(ex.id):undefined,p=e.world.entities.walker.pose.p;
    if(ex?.phase==='climb'&&ex.climbT===0&&rec?.status==='blocked'){atFoot??=e.world.tick;footPose??=[...p];assert.deepEqual(p,footPose,'the body stays at the foot');}
    if(Math.hypot(p[0]-anchor[0],p[2]-anchor[2])>0.5){anchor=[...p];headway=e.world.tick;}
  }
  assert.ok(atFoot!==undefined&&atFoot<200,'the climber is held at the foot, climbT 0');
  const failed=events.filter(x=>x.id===r.id&&x.kind==='failed');assert.equal(failed.length,1);
  assert.equal(failed[0].code,'route.blocked');assert.match(failed[0].message!,/wait-bound\/1/);assert.match(failed[0].message!,/beside/);
  assert.ok(failed[0].tick>=headway+1199&&failed[0].tick<=headway+1201,`ended at ${failed[0].tick}, last headway at ${headway}`);
  assert.deepEqual(e.world.entities.walker.pose.p,footPose,'ended where it stood: not moved, teleported or respawned');
  assert.equal(e.world.entities.walker.human!.level,0);assert.equal(execOf(e,'walker'),undefined,'nothing left behind');
  assert.equal(e.programOf('walker'),null);assert.deepEqual(e.runtime.violations,[]);
});

// #2032 A2: a timeout's retry starts the next walk's own clock. The proving-ground passage again, with a spread goal past it,
// so walk-block/1's timeout re-chooses the spot and walks again from where the body stands.
test('#2032 A2 wait-bound/1: the walk a walk-block retry issues starts its own clock and is not ended early',async()=>{
  const base=(factory.create(factory.genesis('cfg')) as any).cfg,f=await marsFactory({...base,walkBlockV1:true}),w=f.genesis('wait-bound-retry');
  (w.regions as any).yard={id:'yard',label:'Hypothetical yard',provenance:{origin:'test-fixture',confidence:'hypothetical'},kind:'place',level:0,polygon:[[13.5,-11.5],[16.5,-11.5],[16.5,-8.5],[13.5,-8.5]]};
  const e=f.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,yieldTimeoutV1:true,waitBoundV1:true} as never);
  e.spawnHuman({id:B,soul:'s_'+B,label:'Blocker',near:{at:[15,-14.8],first:true}});
  e.spawnHuman({id:W,soul:'s_'+W,label:'Walker',near:{at:[15,-17],first:true}});
  const r=e.perform({actor:W,label:'into the yard',steps:[{verb:'walk_to',params:{to:'yard',spread:'region/1'}}]});assert.equal(r.ok,true,JSON.stringify(r));
  const rt=(e as any).rt,prog=()=>(e as any).programs.get(r.id),starts=new Map<string,number>(),ended:{id:string;start:number;end:number;message:string}[]=[];
  let held=false,clockAfterRetry:unknown='unset';
  for(let i=0;i<2600&&e.programOf(W);i++){
    e.step();const ex=execOf(e,W);
    if(ex&&!held&&ex.narrows.length){const n=ex.narrows[0];(rt.services.traffic??=new Map()).set(n.res,{actors:new Set([B]),entry:n.entry,dir:[-n.dir[0],-n.dir[1]]});held=true;}
    if(ex&&!starts.has(ex.id))starts.set(ex.id,e.world.tick);
    for(const [id,start] of starts)if(!rt.isActive(id)&&!ended.some(x=>x.id===id)){
      ended.push({id,start,end:e.world.tick,message:rt.records.get(id)?.diagnostic?.message??''});
      if(ended.length===1)clockAfterRetry=prog()?.waitBoundV1;
    }
  }
  assert.ok(ended.length>=2,'the walk was retried');assert.match(ended[0].message,/walking has remained blocked for a minute/,'walk-block/1 timed out first');
  assert.equal(clockAfterRetry,undefined,'the retry cleared the wait-bound clock');
  const retried=ended[1];assert.ok(retried.end-retried.start>=1199,`the retried walk ran ${retried.end-retried.start} ticks: ${retried.message}`);
  assert.deepEqual(e.runtime.violations,[]);
});
