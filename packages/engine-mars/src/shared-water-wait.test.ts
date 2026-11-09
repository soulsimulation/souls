import test from 'node:test';
import assert from 'node:assert/strict';
import {retainedCommonsShoreFactory} from './retained-shore-engine.ts';
import type {Engine} from '@souls/engine-contract';
import {connectedCommonsShoreFixture} from './connected-shore.ts';
import {SHORE_POLICY} from '../../../mars/viewer/engine/locomotion/shore.ts';
const geometry=(await connectedCommonsShoreFixture()).geometry;
const factory=await retainedCommonsShoreFactory();
const policy='shared-water-wait/1';
function setup(legacyRetry=true){
 const e=factory.create(factory.genesis('shared-water-wait-fixture'));
 e.spawnHuman({id:'h_actor',label:'scripted native swimmer',soul:'fixture'});
 const provisions=e.previewCommonsProvisionsV1!();assert.ok(provisions.ok,JSON.stringify(provisions));if(provisions.ok)e.adoptCommonsProvisionsV1!(provisions.transition);
 const shore=e.previewRetainedCommonsShoreV1!();assert.ok(shore.ok,JSON.stringify(shore));if(shore.ok)e.adoptRetainedCommonsShoreV1!(shore.transition);
 if(legacyRetry)(e as any).configureRuntimePolicy({sleepBlockTicks:1200,yieldTimeoutV1:true});
 const region=e.world.regions['shore-water'],mid=[0,1].map(k=>region.polygon.reduce((n,p)=>n+p[k],0)/region.polygon.length);
 const entry=e.perform({actor:'h_actor',label:'actual native fixture swimming to open water',steps:[{verb:'walk_to',params:{to:mid}}]});assert.ok(entry.ok,JSON.stringify(entry));assert.equal(finish(e,entry.id).kind,'completed');assert.equal(e.world.entities.h_actor.human!.activity,'tread');return e;
}
function lateHuman(e:Engine,prefix='h_crossing',stationaryHuman?:unknown){
 const a=e.world.entities.h_actor;
 // Eight physically separated scripted fixture humans occupy the first swept
 // water segments AFTER admission. Actual native capsules/shore planner run.
 for(let i=0;i<8;i++){const id=prefix+i,angle=i*Math.PI/4;e.spawnHuman({id,label:'late native water occupant',soul:'fixture'});const b=e.world.entities[id];b.pose.p=[a.pose.p[0]+Math.cos(angle)*.8,a.pose.p[1],a.pose.p[2]+Math.sin(angle)*.8];b.human=structuredClone(stationaryHuman??a.human) as any;const point=geometry.point([b.pose.p[0],b.pose.p[2]])!;assert.ok(point);const floating=point.depth>=SHORE_POLICY.floatingRootBelowDatum;b.pose.p[1]=floating?geometry.datumY-SHORE_POLICY.floatingRootBelowDatum:point.point[1];b.human!.activity=floating?'tread':'idle';(b.human as any).shore={contract:'shore-contact/1',terrainId:geometry.terrainId,waterId:geometry.waterId,mode:floating?'buoyant':'bed',bedY:point.point[1],datumY:geometry.datumY,depthMetres:point.depth,submergedHeightMetres:Math.max(0,Math.min(b.pose.p[1]+SHORE_POLICY.height,geometry.datumY)-Math.max(b.pose.p[1],point.point[1])),normal:point.normal};}
}
function leave(e:Engine,prefix='h_crossing'){const a=e.world.entities.h_actor;for(let i=0;i<8;i++){const angle=i*Math.PI/4,p=e.perform({actor:prefix+i,label:'actual native occupant clears the water route',steps:[{verb:'walk_to',params:{to:[a.pose.p[0]+Math.cos(angle)*2,a.pose.p[2]+Math.sin(angle)*2]}}]});assert.ok(p.ok,JSON.stringify(p));}}
function finish(e:Engine,id:string){for(let i=0;i<4000;i++){const r=e.step();assert.deepEqual(e.runtime.violations,[]);const terminal=r.programs.find(p=>p.id===id&&p.kind!=='step');if(terminal)return terminal;}throw Error('programme did not finish within native bound');}
for(const later of [false,true])test(`prospective water wait survives actual late human at ${later?'later lowering before soft lap op':'first lowering'}`,()=>{
 const e=setup(),walk={verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:policy}};
 const p=e.perform({actor:'h_actor',label:'scripted late crossing seam',steps:[...(later?[{verb:'rest',params:{seconds:1}}]:[]),walk,{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok,JSON.stringify(p));lateHuman(e);
 const initial=[...e.world.entities.h_actor.pose.p];let failed:any;
 for(let i=0;i<(later?25:5);i++){const r=e.step();failed??=r.programs.find(x=>x.id===p.id&&x.kind==='failed');assert.deepEqual(e.runtime.violations,[]);}
 assert.equal(failed,undefined,JSON.stringify(failed));assert.deepEqual(e.world.entities.h_actor.pose.p,initial,'occupied route must not move through a body');
 leave(e);assert.equal(finish(e,p.id).kind,'completed');assert.equal(e.world.entities.h_actor.human!.activity,'tread');
});

test('each prospective water leg gets its own bounded wait after actual earlier wait consumption',()=>{
 const e=setup(),walk={verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:policy}},p=e.perform({actor:'h_actor',label:'actual two contested water legs',steps:[{verb:'rest',params:{seconds:1}},walk,{verb:'rest',params:{seconds:1}},walk,{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok,JSON.stringify(p));lateHuman(e);
 for(let i=0;i<1120;i++){const r=e.step();assert.ok(!r.programs.some(x=>x.id===p.id&&x.kind==='failed'),JSON.stringify(r.programs));assert.deepEqual(e.runtime.violations,[]);}
 leave(e);let between=false;
 for(let i=0;i<1400;i++){const out=e.step();assert.ok(!out.programs.some(x=>x.id===p.id&&x.kind==='failed'),JSON.stringify(out.programs));assert.deepEqual(e.runtime.violations,[]);if((e.snapshot() as any).programs.find((x:any)=>x.id===p.id)?.index===2){between=true;break;}}
 assert.ok(between,'first real water leg completed into its ordinary rest');lateHuman(e,'h_second');
 for(let i=0;i<240;i++){const out=e.step();assert.ok(!out.programs.some(x=>x.id===p.id&&x.kind==='failed'),JSON.stringify(out.programs));assert.deepEqual(e.runtime.violations,[]);}
 leave(e,'h_second');assert.equal(finish(e,p.id).kind,'completed');
});

test('permanent body obstruction stays bounded and never becomes an arrival',()=>{
 const e=setup(),initial=[...e.world.entities.h_actor.pose.p],p=e.perform({actor:'h_actor',label:'bounded body crowd',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:policy}}]});assert.ok(p.ok);lateHuman(e);const begin=e.world.tick,terminal=finish(e,p.id);assert.equal(terminal.kind,'failed');assert.equal(terminal.code,'shore.occupied-route');assert.ok(e.world.tick-begin<=1201);assert.ok(Math.hypot(e.world.entities.h_actor.pose.p[0]-initial[0],e.world.entities.h_actor.pose.p[2]-initial[2])<.25,'native approach stops before the .8m ring of .28m capsules');assert.equal(e.world.entities.h_actor.human!.activity,'tread');
});
test('static occupied water route is refused without turning into a body wait',()=>{
 const e=setup(),a=e.world.entities.h_actor,p=e.perform({actor:'h_actor',label:'actual static water obstruction',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:policy}}]});assert.ok(p.ok);
 for(let i=0;i<8;i++){const angle=i*Math.PI/4,id='fixture-chair'+i;e.world.entities[id]={id,def:'camp-chair',kind:'fixture',pose:{p:[a.pose.p[0]+Math.cos(angle)*1.2,(a.human as any).shore.bedY,a.pose.p[2]+Math.sin(angle)*1.2],yaw:0},provenance:{origin:'test-fixture',confidence:'hypothetical'},support:{kind:'ground'}} as any;}
 const terminal=e.step().programs.find(x=>x.id===p.id&&x.kind!=='step');assert.equal(terminal?.kind,'failed',JSON.stringify(terminal));assert.equal(terminal?.code,'shore.occupied-route');assert.deepEqual(e.runtime.violations,[]);
});
test('explicit unknown policy refuses and a finite waiting snapshot resumes exactly',()=>{
 const e=setup(false),unknown={actor:'h_actor',label:'unsupported future policy',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:'shared-water-wait/9'}}]},hash=e.stateHash();assert.equal(e.canPerform(unknown)?.code,'action.invalid-spread-wait-policy');assert.equal(e.stateHash(),hash);
 const p=e.perform({...unknown,steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:policy}},{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok);lateHuman(e);for(let i=0;i<45;i++)e.step();
 const snap=e.snapshot(),copy=factory.restore(snap);assert.equal(copy.stateHash(),e.stateHash());leave(e);leave(copy);let terminal=false;
 for(let i=0;i<1500&&!terminal;i++){const a=e.step(),b=copy.step();assert.equal(copy.stateHash(),e.stateHash());assert.deepEqual(b.programs,a.programs);terminal=a.programs.some(x=>x.id===p.id&&x.kind==='completed');}assert.ok(terminal);
 const tampered=structuredClone(snap) as any;tampered.programs[0].steps[0].params.spreadWaitPolicy='shared-water-wait/9';assert.throws(()=>factory.restore(tampered),/unknown-spread-wait-policy/);
});

test('accepted soft water action blocked by late bodies exhausts as failure rather than skipped arrival',()=>{
 const e=setup(),stationary=structuredClone(e.world.entities.h_actor.human),p=e.perform({actor:'h_actor',label:'late body after actual native submission',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:policy}},{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok);e.step();e.step();assert.ok((e.snapshot() as any).programs.find((x:any)=>x.id===p.id)?.action,'native action has actually been submitted');lateHuman(e,'h_crossing',stationary);const initial=[...e.world.entities.h_actor.pose.p],start=e.world.tick,terminal=finish(e,p.id);assert.equal(terminal.kind,'failed');assert.equal(terminal.code,'shore.occupied-route');assert.ok(e.world.tick-start<=2600,'native hold plus actual renewals remain bounded');assert.ok(Math.hypot(e.world.entities.h_actor.pose.p[0]-initial[0],e.world.entities.h_actor.pose.p[2]-initial[2])<.25,'native approach stops before the .8m ring of .28m capsules');assert.equal(e.world.entities.h_actor.human!.activity,'tread');
});

// #1291 shared-water-wait/3: a parked-only wait budget with a 180 s hard cap, and a gate-cycle yield for swim steps only.
const V3='shared-water-wait/3';
test('/3: behind parked bodies the wait stays bounded at about a minute, as /1',()=>{
 const e=setup(),initial=[...e.world.entities.h_actor.pose.p],p=e.perform({actor:'h_actor',label:'parked crowd under /3',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}}]});assert.ok(p.ok);lateHuman(e);
 const begin=e.world.tick,terminal=finish(e,p.id);assert.equal(terminal.kind,'failed');assert.equal(terminal.code,'shore.occupied-route');assert.match(terminal.message??'',/must wait for h_crossing/);
 assert.ok(e.world.tick-begin<=1201,String(e.world.tick-begin));assert.ok(Math.hypot(e.world.entities.h_actor.pose.p[0]-initial[0],e.world.entities.h_actor.pose.p[2]-initial[2])<.25);
});
test('/3: behind bodies that stay active movers the wait still ends at the 180 s hard cap, without moving through them',()=>{
 const e=setup(),initial=[...e.world.entities.h_actor.pose.p],p=e.perform({actor:'h_actor',label:'queued crowd under /3',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}}]});assert.ok(p.ok);lateHuman(e);
 // The water fixture cannot hold eight native movers queued for minutes, so only the liveness read is held true:
 // every blocker counts as an active mover, the budget never runs out, and only the hard cap ends the wait.
 (e as any).sharedWaterQueuedV3=()=>true;
 const begin=e.world.tick,terminal=finish(e,p.id);assert.equal(terminal.kind,'failed');assert.equal(terminal.code,'shore.occupied-route');
 const waited=e.world.tick-begin;assert.ok(waited>=3600-20&&waited<=3600+40,String(waited));
 assert.ok(Math.hypot(e.world.entities.h_actor.pose.p[0]-initial[0],e.world.entities.h_actor.pose.p[2]-initial[2])<.25,'never through the crowd');assert.deepEqual(e.runtime.violations,[]);
});
test('/3: a snapshot taken mid-wait restores and steps state-hash identical',()=>{
 const e=setup(false),p=e.perform({actor:'h_actor',label:'/3 snapshot',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}},{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok);lateHuman(e);for(let i=0;i<45;i++)e.step();
 const snap=e.snapshot(),copy=factory.restore(snap);assert.equal(copy.stateHash(),e.stateHash());leave(e);leave(copy);let terminal=false;
 for(let i=0;i<1500&&!terminal;i++){const a=e.step(),b=copy.step();assert.equal(copy.stateHash(),e.stateHash());assert.deepEqual(b.programs,a.programs);terminal=a.programs.some(x=>x.id===p.id&&x.kind==='completed');}assert.ok(terminal);
});
test('/3 reads a blocker as queued only while it has an active native movement of its own',()=>{
 const e=setup(false) as any;e.spawnHuman({id:'h_walker',label:'dry walker',soul:'fixture'});
 const w=e.world.entities.h_walker,d={code:'shore.occupied-route',message:'h_actor must wait for h_walker',subjects:['h_actor','h_walker']};
 assert.equal(e.sharedWaterQueuedV3('h_actor',d),false,'a parked body is not a queue');
 const p=e.perform({actor:'h_walker',label:'a real native walk',steps:[{verb:'walk_to',params:{to:[w.pose.p[0]+6,w.pose.p[2]]}}]});assert.ok(p.ok,JSON.stringify(p));e.step();e.step();
 assert.equal(e.sharedWaterQueuedV3('h_actor',d),true,'a body on its own native walk is a queue');
 assert.equal(e.sharedWaterQueuedV3('h_actor',{...d,subjects:['h_actor']}),false,'no other body named, no queue');
 finish(e,p.id);assert.equal(e.sharedWaterQueuedV3('h_actor',d),false,'parked again once its walk ends');
});
test('/3: a walk held past the 180 s cap is stopped (shore.wait-capped) and the swim ends shore.occupied-route, naming the cap',()=>{
 const e=setup(),stationary=structuredClone(e.world.entities.h_actor.human),p=e.perform({actor:'h_actor',label:'walk held at the cap',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}},{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok);
 e.step();e.step();const prog=(e as any).programs.get(p.id);assert.ok(prog?.action,'native action has actually been submitted');lateHuman(e,'h_crossing',stationary);
 // The step's first wait began a full cap ago (as for a walk resubmitted at 179 s): the live, held walk must stop now.
 prog.waterWait={step:prog.index,since:e.world.tick-3600,attempts:1};
 const rt=(e as any).rt,cancels:string[]=[],cancel=rt.cancel.bind(rt);rt.cancel=(id:string,why:any)=>{cancels.push(why?.code);return cancel(id,why);};
 const initial=[...e.world.entities.h_actor.pose.p],start=e.world.tick;let terminal:any;
 for(let i=0;i<400&&!terminal;i++){const r=e.step();terminal=r.programs.find(x=>x.id===p.id&&x.kind!=='step');assert.deepEqual(e.runtime.violations,[]);}
 assert.ok(cancels.includes('shore.wait-capped'),JSON.stringify(cancels));assert.equal(terminal?.kind,'failed',JSON.stringify(terminal));assert.equal(terminal.code,'shore.occupied-route');
 assert.match(terminal.message,/180 s limit at the shore/);assert.ok(e.world.tick-start<=400,'stops within seconds of the cap, not a minute-long walk timeout');
 assert.ok(Math.hypot(e.world.entities.h_actor.pose.p[0]-initial[0],e.world.entities.h_actor.pose.p[2]-initial[2])<.25,'never through the crowd');
});
test('/3 gate-cycle yield: make-way counts only when its native walk runs; with no room the wait is noted and retried after 1 s',()=>{
 const e=setup(false) as any,p=e.perform({actor:'h_actor',label:'yield bookkeeping',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}}]});assert.ok(p.ok);
 e.spawnHuman({id:'h_other',label:'other swimmer',soul:'fixture'});
 const prog=e.programs.get(p.id),d={code:'shore.occupied-route',message:'h_actor must wait for h_other',subjects:['h_actor','h_other'],details:{cycleYield:true}};
 const real=e.m.makeWay;
 // no free spot: make-way submits nothing
 e.m={...e.m,makeWay:()=>{}};prog.waterWait={step:prog.index,since:e.world.tick,attempts:0};
 assert.equal(e.sharedWaterMakeWayV3(prog,d),false);assert.equal(prog.waterWait.note,'shore.cycle-yield-no-room');
 // make-way's walk is refused by the native runtime: still not a step aside
 e.m={...e.m,makeWay:(rt:any,who:string)=>{rt.submit('walk_to',{actor:who,x:1e6,z:1e6},{id:`${who}:make-way:${rt.tick}`});}};
 assert.equal(e.sharedWaterMakeWayV3(prog,d),false);assert.equal(prog.waterWait.note,'shore.cycle-yield-no-room');
 // through the retry path the no-room yield waits 1 s, not the 3 s of a real step aside
 e.m={...e.m,makeWay:()=>{}};const at=prog.index;assert.equal(e.retrySharedWaterV1(prog,d),true);assert.deepEqual(prog.ops,[{wait:20}]);prog.index=at;
 e.m={...e.m,makeWay:real};assert.deepEqual(e.runtime.violations,[]);
 // (a real step aside with room is the pinned four-swims set in apps/server/src/edge-ledger-swim.test.ts)
});
for(const after of [0,2,40])test(`/3: a free swim past the cap is never cut off (cap reached ${after} steps into the walk)`,()=>{
 const e=setup(),p=e.perform({actor:'h_actor',label:'clear way past the cap',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}},{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok);
 for(let i=0;i<after;i++)e.step();const prog=(e as any).programs.get(p.id);prog.waterWait={step:prog.index<0?0:prog.index,since:e.world.tick-3600,attempts:1};
 const rt=(e as any).rt,cancels:string[]=[],cancel=rt.cancel.bind(rt);rt.cancel=(id:string,why:any)=>{cancels.push(why?.code);return cancel(id,why);};
 const initial=[...e.world.entities.h_actor.pose.p];assert.equal(finish(e,p.id).kind,'completed');assert.ok(!cancels.includes('shore.wait-capped'),JSON.stringify(cancels));
 assert.ok(Math.hypot(e.world.entities.h_actor.pose.p[0]-initial[0],e.world.entities.h_actor.pose.p[2]-initial[2])>=4,'it actually swam its lap');
});
test('/3: a walk held past the cap with no body named is still stopped, and says it was held',()=>{
 const e=setup(),stationary=structuredClone(e.world.entities.h_actor.human),p=e.perform({actor:'h_actor',label:'held, nobody named',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}},{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok);
 e.step();e.step();const eng=e as any,prog=eng.programs.get(p.id);assert.ok(prog?.action);lateHuman(e,'h_crossing',stationary);
 // nothing names a body: no published people wait, no human subjects anywhere in the record tree
 eng.sharedWaterBlockingAction=()=>undefined;eng.sharedWaterSubjectsV3=()=>[];
 prog.waterWait={step:prog.index,since:e.world.tick-3600,attempts:1};
 const rt=eng.rt,cancels:string[]=[],cancel=rt.cancel.bind(rt);rt.cancel=(id:string,why:any)=>{cancels.push(why?.code);return cancel(id,why);};
 const start=e.world.tick;let terminal:any;for(let i=0;i<400&&!terminal;i++){const r=e.step();terminal=r.programs.find(x=>x.id===p.id&&x.kind!=='step');assert.deepEqual(e.runtime.violations,[]);}
 assert.ok(cancels.includes('shore.wait-capped'),JSON.stringify(cancels));assert.equal(terminal?.kind,'failed',JSON.stringify(terminal));assert.equal(terminal.code,'shore.occupied-route');
 assert.match(terminal.message,/is held on the way into the water; waited the 180 s limit/);assert.ok(e.world.tick-start<=400);
});
test('/3 backstop: a walk still unfinished 45 s past the cap stops even while it keeps moving',()=>{
 const e=setup(),stationary=structuredClone(e.world.entities.h_actor.human),p=e.perform({actor:'h_actor',label:'jostled past the cap',steps:[{verb:'walk_to',params:{to:'shore-water',spread:'pond-lap/1',spreadWaitPolicy:V3}},{verb:'rest',params:{seconds:1}}]});assert.ok(p.ok);
 e.step();e.step();const eng=e as any,prog=eng.programs.get(p.id);assert.ok(prog?.action);lateHuman(e,'h_crossing',stationary);
 // the walk reads as never held (a body jostled more than 0.5 m every 2 s): only the backstop can end it
 eng.sharedWaterHeldV3=()=>false;prog.waterWait={step:prog.index,since:e.world.tick-3600,attempts:1};
 const rt=eng.rt,cancels:{code:string;tick:number}[]=[],cancel=rt.cancel.bind(rt);rt.cancel=(id:string,why:any)=>{cancels.push({code:why?.code,tick:e.world.tick});return cancel(id,why);};
 const start=e.world.tick;let terminal:any;for(let i=0;i<1400&&!terminal;i++){const r=e.step();terminal=r.programs.find(x=>x.id===p.id&&x.kind!=='step');assert.deepEqual(e.runtime.violations,[]);}
 const capped=cancels.find(c=>c.code==='shore.wait-capped');assert.ok(capped,JSON.stringify(cancels));
 assert.ok(capped.tick-start>=45*20-2&&capped.tick-start<=45*20+2,'stops at cap + 45 s: '+(capped.tick-start));
 assert.equal(terminal?.kind,'failed',JSON.stringify(terminal));assert.equal(terminal.code,'shore.occupied-route');assert.match(terminal.message,/waited the 180 s limit at the shore/);
});
