// #1367 wait-bound/3: a walk held at a stair foot by shoves or a wait cycle ends within the bound. Under wait-bound/1 a
// walk's headway is leaving a 0.5 m disc, so each shove in the jam at a flight's foot (a yield, a step-aside and its walk
// back, a queue shuffling) restarted its clock and a walk going nowhere stayed open. Under wait-bound/3 headway is getting
// 0.5 m nearer the way of the walk's leg (here the flight's foot) or changing level.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,type MarsEngine} from './engine.ts';
import {loadMars} from './load.ts';
import type {ProgramEvent} from '@souls/engine-contract';

// The commons deck's single-file flight: foot (9, -0.4) on the ground, head (9, -1.4) on the deck (level 1).
const FOOT=[9,-0.4],BOUND=1200,TICKS=6000;
// The boot policy an eden world runs (its runtime-policy event), with wait-bound/1 and /2: #2152's head.
const BASE={sleepBlockTicks:1200,quietStallReleaseV1:true,yieldTimeoutV1:true,spreadV2:true,routeReachV1:true,occupiedLinkRoutingV1:true,
  concurrentLinkEgressV1:true,stairLandingClearanceV1:true,bodyStepGuardV1:true,refusalSettleV1:true,stairWayV1:true,standHeightV1:true,
  standHeightV2:true,waitBoundV1:true,waitBoundV2:true};
const f=await marsFactory(EDEN_SAFE_COMMONS_WORLD),m=await loadMars();
const execOf=(e:MarsEngine,actor:string):any=>{const t=e.world.entities[actor].human?.task;return t?(e as any).rt.services.walkExecs?.get(t):undefined;};

/** Six walkers go up onto the deck and two come down it to the lawn, each sent again 40 ticks after its walk ends. They
 *  meet at the foot: they yield to each other, wait in cycles, step aside and shuffle. `adoptAt` adopts wait-bound/3 then. */
function foot(opts:{adoptAt?:number;ticks?:number;hashes?:boolean}={}){
  const w=f.genesis('stair-foot'),up:string[]=[],ids:string[]=[];
  for(let i=0;i<6;i++){const id=`h_up${i}`;w.entities[id]=m.human(id,8.2+.8*i,1.2+.3*(i%2),{yaw:-Math.PI/2});up.push(id);ids.push(id);}
  for(let i=0;i<2;i++){const id=`h_dn${i}`;w.entities[id]=m.human(id,8+i,-2.2+.6*(i%2),{level:1,y:.24,yaw:Math.PI/2});ids.push(id);}
  const e=f.create(w) as MarsEngine;e.configureRuntimePolicy({...BASE,...(opts.adoptAt===0?{waitBoundV3:true}:{})} as never);
  const send=(id:string)=>{const goUp=e.world.entities[id].human!.level===0;
    const r=e.perform({actor:id,label:goUp?'up':'down',steps:[{verb:'walk_to',params:goUp?{to:'commons-deck',standoff:0}:{to:'commons'}}]});
    assert.equal(r.ok,true,JSON.stringify(r));return r.id!;};
  type Walk={id:string;actor:string;since:number;best:number;anchor:number[];shoves:number;level:number;end?:ProgramEvent;stale:number};
  const walks:Walk[]=[],live=new Map<string,Walk>(),resend=new Map<string,number>(),hashes:string[]=[];
  const open=(actor:string)=>{const p=e.world.entities[actor].pose.p,wk:Walk={id:send(actor),actor,since:e.world.tick,best:Infinity,anchor:[...p],shoves:0,level:e.world.entities[actor].human!.level,stale:0};walks.push(wk);live.set(actor,wk);};
  for(const id of ids)open(id);
  let jump=0;const before=Object.keys(e.world.entities).length;
  for(let t=1;t<=(opts.ticks??TICKS);t++){
    if(opts.adoptAt&&t===opts.adoptAt)e.configureRuntimePolicy({...BASE,waitBoundV3:true} as never);
    const was=Object.fromEntries(ids.map(id=>[id,[...e.world.entities[id].pose.p]]));
    const ev=e.step().programs;if(opts.hashes)hashes.push(e.stateHash());
    for(const id of ids){const p=e.world.entities[id].pose.p,q=was[id];jump=Math.max(jump,Math.hypot(p[0]-q[0],p[2]-q[2]));}
    for(const x of ev){if(x.kind==='step')continue;const wk=[...live.values()].find(v=>v.id===x.id);if(!wk)continue;wk.end=x;live.delete(wk.actor);resend.set(wk.actor,t+40);}
    for(const [id,at] of resend)if(t>=at){resend.delete(id);open(id);}
    // The scene's own measure, for an up-walk on the ground: headway is getting 0.5 m nearer the foot; a 0.5 m move that is not is a shove.
    for(const wk of live.values()){
      const a=e.world.entities[wk.actor],p=a.pose.p,ex=execOf(e,wk.actor),d=Math.hypot(p[0]-FOOT[0],p[2]-FOOT[1]);
      if(a.human!.level!==0||wk.level!==0||!ex||ex.phase==='climb'||ex.cancelTo||ex.leg>1){wk.since=t;wk.best=Infinity;wk.anchor=[...p];continue;}
      if(d<wk.best-.5||wk.best===Infinity){wk.best=d;wk.since=t;wk.anchor=[...p];continue;}
      if(Math.hypot(p[0]-wk.anchor[0],p[2]-wk.anchor[2])>.5){wk.shoves++;wk.anchor=[...p];}
      wk.stale=Math.max(wk.stale,t-wk.since);
    }
  }
  return {e,walks,jump,hashes,bodies:[before,Object.keys(e.world.entities).length]};
}

test('#1367 A2 without wait-bound/3: shoves at the deck foot keep an up-walk open long past the bound (wait-bound/1 on)',()=>{
  const {e,walks}=foot(),held=walks.filter(w=>w.stale>BOUND+100);
  assert.ok(held.length>0,`a walk at the foot stays open more than ${BOUND+100} ticks after it last got 0.5 m nearer the foot: ${walks.map(w=>w.stale).sort((a,b)=>b-a).slice(0,3)}`);
  assert.ok(held.some(w=>w.shoves>0),'and it was shoved meanwhile (moved 0.5 m without getting nearer)');
  const codes=new Set(walks.map(w=>w.end?.message?.match(/(deadlock\.cycle|traffic\.yield|traffic\.person)/)?.[1]).filter(Boolean));
  assert.ok(codes.size>=2,`the walkers wait on each other: ${[...codes]}`);
  assert.deepEqual(e.runtime.violations,[]);
});

test('#1367 A1 wait-bound/3: every up-walk held at the foot ends route.blocked within the bound, named, and nothing teleports or respawns',()=>{
  const {e,walks,jump,bodies}=foot({adoptAt:0});
  // The engine measures what is left of the walk's own leg, the scene the straight distance to the foot; 100 ticks (5 s) covers a path that bends.
  const worst=walks.reduce((a,b)=>b.stale>a.stale?b:a);
  assert.ok(worst.stale<=BOUND+100,`${worst.actor}'s walk ${worst.id} stayed open ${worst.stale} ticks after it last got 0.5 m nearer the foot`);
  const bound=walks.filter(w=>/^wait-bound\/3: /.test(w.end?.message??''));
  assert.ok(bound.length>0,'the bound ended walks at the foot');
  for(const w of bound){assert.equal(w.end!.kind,'failed');assert.equal(w.end!.code,'route.blocked');assert.match(w.end!.message!,/made no headway for a minute: [a-z.-]+/);}
  assert.ok(jump<.3,`no teleport: the largest step was ${jump.toFixed(2)} m`);assert.equal(bodies[1],bodies[0],'no body added or removed');
  assert.deepEqual(e.runtime.violations,[]);
});

test('#1367 A1 history before adoption replays as recorded: the same journal with wait-bound/3 adopted at tick 3,000 has identical hashes before it',()=>{
  const recorded=foot({ticks:3200,hashes:true}),adopted=foot({ticks:3200,hashes:true,adoptAt:3000});
  assert.deepEqual(adopted.hashes.slice(0,2999),recorded.hashes.slice(0,2999),'every state hash before the adoption is the recorded one');
  assert.notEqual(adopted.hashes[2999],recorded.hashes[2999],'the adoption itself is in the state');
});

test('#1367 wait-bound/3 is a named state-hash input of its own',()=>{
  const two=f.create(f.genesis('wait-bound-3-hash')) as MarsEngine,three=f.create(f.genesis('wait-bound-3-hash')) as MarsEngine;
  two.configureRuntimePolicy(BASE as never);three.configureRuntimePolicy({...BASE,waitBoundV3:true} as never);
  assert.notEqual(two.stateHash(),three.stateHash());
});

/** A walker's own walk waits behind a make-way nudge of its body (walk.ts makeWay) that is held at the proving ground's
 *  1.0 m passage, where a body holds the passage and never leaves (as in wait-bound.test.ts). */
async function heldNudge(policy:Record<string,boolean>){
  const pg=await marsFactory(),w=pg.genesis('wait-bound-3-nudge'),W='h_walker000',B='h_block0000';
  w.entities[B]=m.human(B,15,-14.8);w.entities[W]=m.human(W,19,-17);
  const e=pg.create(w) as MarsEngine,rt=(e as any).rt;e.configureRuntimePolicy({...BASE,...policy} as never);
  const nudge=`${W}:make-way:1`,move=rt.submit('walk_to',{actor:W,x:14.8,z:-10},{id:nudge});move.internalCause='traffic.make-way';
  let held=false;
  for(let i=0;i<200&&rt.records.get(nudge).status!=='blocked';i++){
    e.step();const ex=rt.services.walkExecs?.get(nudge);
    if(ex&&!held&&ex.narrows.length){const n=ex.narrows[0];(rt.services.traffic??=new Map()).set(n.res,{actors:new Set([B]),entry:n.entry,dir:[-n.dir[0],-n.dir[1]]});held=true;}
  }
  assert.equal(rt.records.get(nudge).status,'blocked','the nudge is held at the passage');
  const r=e.perform({actor:W,label:'own walk',steps:[{verb:'mars:walk_to',params:{x:19,z:-19}}]});assert.equal(r.ok,true,JSON.stringify(r));
  const action=()=>[...(e as any).programs.values()].find((q:any)=>q.actor===W)?.action;
  let execAt:number|undefined,jump=0;const t0=e.world.tick;
  for(let i=0;i<600&&execAt===undefined;i++){
    const was=[...e.world.entities[W].pose.p];e.step();const p=e.world.entities[W].pose.p;jump=Math.max(jump,Math.hypot(p[0]-was[0],p[2]-was[2]));
    const id=action();if(id&&rt.live.get(id))execAt=e.world.tick;
  }
  return {e,rt,nudge,execAt,t0,jump};
}

test('#1367 A1 make-way: a walk step held behind its body\'s blocked make-way nudge is left with no exec without wait-bound/3',async()=>{
  const {e,rt,nudge,execAt}=await heldNudge({});
  assert.equal(execAt,undefined,'600 ticks on, the walk step still has no exec');assert.equal(rt.isActive(nudge),true,'the nudge is still held');
  assert.deepEqual(e.runtime.violations,[]);
});

test('#1367 A1 make-way: under wait-bound/3 the held nudge ends where the body stands and the walk step gets its exec at once',async()=>{
  const {e,rt,nudge,execAt,t0,jump}=await heldNudge({waitBoundV3:true});
  assert.ok(execAt!==undefined&&execAt-t0<=3,`the walk step has an exec ${execAt===undefined?'never':execAt-t0+' ticks on'}`);
  assert.equal(rt.isActive(nudge),false);assert.equal(rt.records.get(nudge).diagnostic?.code,'traffic.make-way-ended');
  assert.ok(jump<.3,`no teleport: the largest step was ${jump.toFixed(2)} m`);assert.deepEqual(e.runtime.violations,[]);
});

test('#1367 wait-bound/3 does not end a free walk that must first go away from its goal (into the proving ground\'s U cup, slowly)',async()=>{
  // The goal is inside the cup, 1.2 m away past its back wall. The way round is about 18 m, so at 0.3 m/s (the slowest
  // walk) the straight distance to the goal does not fall 0.5 m below where it started for most of the bound; a longer wall
  // would take it past. Less of the leg is left to walk all the time, so the bound's clock restarts every few seconds.
  const pg=await marsFactory(),w=pg.genesis('wait-bound-3-round'),goal=[-15,14.6];w.entities.h_round0=m.human('h_round0',-15,15.8);
  const e=pg.create(w) as MarsEngine;e.configureRuntimePolicy({...BASE,waitBoundV3:true} as never);
  const r=e.perform({actor:'h_round0',label:'round the wall',steps:[{verb:'mars:walk_to',params:{x:goal[0],z:goal[1],speed:.3}}]});assert.equal(r.ok,true,JSON.stringify(r));
  const events:ProgramEvent[]=[];let best=Infinity,since=0,stale=0,clock=0;
  for(let i=0;i<6000&&e.programOf('h_round0');i++){
    events.push(...e.step().programs);const p=e.world.entities.h_round0.pose.p,d=Math.hypot(p[0]-goal[0],p[2]-goal[1]);
    if(d<best-.5||best===Infinity){best=d;since=e.world.tick;}stale=Math.max(stale,e.world.tick-since);
    const wb=([...(e as any).programs.values()].find((q:any)=>q.actor==='h_round0'))?.waitBoundV1;if(wb)clock=Math.max(clock,e.world.tick-wb.since);
  }
  assert.ok(stale>900,`the straight distance to the goal did not fall for ${stale} ticks`);
  assert.ok(clock<=100,`the bound's clock ran ${clock} ticks at most`);
  const end=events.find(x=>x.id===r.id&&x.kind!=='step');assert.equal(end?.kind,'completed',JSON.stringify(end));
});
