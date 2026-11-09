// #1521 stand-height/2: on a world with no ground field (Eden core), a stall release on level 0 kept the body's own height. A body
// stalled mid-climb onto the commons deck (level 1, floor 0.24) was set down on level 0 at y 0.24, in the air; the first tick of
// every walk put it on its floor, a 0.24 m drop the step check refuses as motion.teleport, so it never walked again. Under the
// policy it stands at its floor's height, and the adoption stands any body already left in the air on its floor, once.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,type MarsEngine} from './engine.ts';
import {loadMars} from './load.ts';

const m=await loadMars();
const commons=await marsFactory({...EDEN_SAFE_COMMONS_WORLD,walkBlockV1:true});
const AIR=.24,AT=[9,-4.6] as const;   // level 0 near the commons deck; the deck floor's height

function world(policy:boolean,y=0){
  const w=commons.genesis('stand-height-ground') as any;w.entities.body=m.human('body',AT[0],AT[1],{level:0,y});
  const e=commons.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,standHeightV1:true,...(policy?{standHeightV2:true}:{})} as never);
  return e;
}
/** Walks `body` 2 m along x for up to 60 ticks: how far it got and the step check's refusals on the way. */
function walk(e:MarsEngine){
  const b=e.world.entities.body,x0=b.pose.p[0],v0=e.runtime.violations.length;
  const r=e.perform({actor:'body',label:'walk',steps:[{verb:'mars:walk_to',params:{x:x0+2,z:b.pose.p[2],level:0}}]});assert.equal(r.ok,true,JSON.stringify(r));
  for(let i=0;i<60&&e.programOf('body');i++)e.step();
  return {moved:Math.abs(b.pose.p[0]-x0),teleports:e.runtime.violations.slice(v0).filter((v:any)=>v.code==='motion.teleport').length};
}
function stallMidClimb(e:MarsEngine){
  const b=e.world.entities.body;
  const r=e.perform({actor:'body',label:'walk',steps:[{verb:'mars:walk_to',params:{x:AT[0]-.5,z:AT[1],level:0}}]});assert.equal(r.ok,true,JSON.stringify(r));
  e.step();b.pose.p=[b.pose.p[0],AIR,b.pose.p[2]];   // held at a mid-climb height, as the stalled body was
  const rel=(e as any).stallReleaseV1('body',{code:'stall.released',message:'test'});assert.ok(rel,'released');
  for(let i=0;i<5&&e.programOf('body');i++)e.step();
  return b;
}

test('#1521 the world has no ground field (the case stand-height/2 is for)',()=>{assert.ok(!(world(true).world as any).groundV1);});

for(const policy of [false,true])
  test(`#1521 a level-0 stall release of a body at a mid-climb height ${policy?'stands it on its floor, and it walks':'keeps that height (as recorded), and its first walk step is a motion.teleport'}`,()=>{
    const e=world(policy),b=stallMidClimb(e);
    assert.equal(b.human!.level,0);
    if(policy){assert.ok(Math.abs(b.pose.p[1])<1e-9,`on the floor: ${b.pose.p[1]}`);const w=walk(e);assert.equal(w.teleports,0,'no motion.teleport');assert.ok(w.moved>1,`walked ${w.moved} m`);}
    else{assert.equal(b.pose.p[1],AIR);const w=walk(e);assert.ok(w.teleports>0,'its first step is a motion.teleport, which the repair rules refuse on every walk: the #1521 freeze');}
  });

test('#1521 the adoption repair: a body already left in the air is planned onto its floor at the same point, and then walks',()=>{
  const e=world(false),b=stallMidClimb(e);
  assert.equal(b.pose.p[1],AIR,'left in the air (no policy at the release)');
  e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,standHeightV1:true,standHeightV2:true} as never);
  const plan=e.planAboveFloorV2();
  assert.deepEqual(plan.map(x=>x.id),['body']);assert.equal(plan[0].p[1],0);
  assert.deepEqual([plan[0].p[0],plan[0].p[2]],[Math.round(b.pose.p[0]*1000)/1000,Math.round(b.pose.p[2]*1000)/1000],'the same point: it is clear');
  assert.deepEqual(e.standOnFloorV2(plan),['body']);
  const w=walk(e);assert.equal(w.teleports,0);assert.ok(w.moved>1,`walked ${w.moved} m`);
});

test('#1521 the adoption repair leaves a body standing on its floor, and one on the deck, untouched',()=>{
  const e=world(true);
  assert.deepEqual(e.planAboveFloorV2(),[],'on its floor');
  const w=commons.genesis('stand-height-ground') as any;w.entities.body=m.human('body',9,-2.6,{level:1,y:AIR});
  const d=commons.create(w) as MarsEngine;d.configureRuntimePolicy({sleepBlockTicks:1200,standHeightV2:true} as never);
  assert.deepEqual(d.planAboveFloorV2(),[],'upstairs is stand-height/1\'s');
});

test('#1521 the adoption repair leaves a body that is busy (a programme) or held alone',()=>{
  const e=world(true,AIR);
  const r=e.perform({actor:'body',label:'walk',steps:[{verb:'mars:walk_to',params:{x:AT[0]+3,z:AT[1],level:0}}]});assert.equal(r.ok,true);
  assert.deepEqual(e.planAboveFloorV2(),[],'a body with a programme is never moved by the repair');
});
