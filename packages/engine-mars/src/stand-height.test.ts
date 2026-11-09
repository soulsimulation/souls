// #1454 stand-height/1: a body the engine places upstairs (a restore, a settle, a stall release) stood at the height it had, so a
// body caught on a flight or mid-climb was stood on a floor cell in the air (the #1367 class: the first walk snaps it to the floor
// and is refused motion.teleport on every walk). Under the policy it stands at its floor's own height. Without it, as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,type MarsEngine} from './engine.ts';
import {loadMars} from './load.ts';

const m=await loadMars();
const commons=await marsFactory({...EDEN_SAFE_COMMONS_WORLD,walkBlockV1:true});
const DECK=.24;   // the commons deck (level 1) floor height

function deck(policy:boolean){
  const w=commons.genesis('stand-height') as any;w.entities.body=m.human('body',9,-2.6,{level:1,y:DECK});
  const e=commons.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,...(policy?{standHeightV1:true}:{})});
  return e;
}

for(const policy of [false,true])
  test(`#1454 a restore upstairs from a pose off the floor's height ${policy?'stands the body on its floor':'keeps that height (as recorded)'}`,()=>{
    const e=deck(policy),b=e.world.entities.body;
    // a pose taken mid-climb: on the deck's level, 0.12 m under its floor
    assert.equal(e.restoreHumanPoseV1('body',{p:[9,.12,-2.6],level:1}),true);
    assert.equal(b.human!.level,1);
    if(policy)assert.ok(Math.abs(b.pose.p[1]-DECK)<1e-9,`on the deck floor: ${b.pose.p[1]}`);
    else assert.equal(b.pose.p[1],.12);
  });

test('#1454 under stand-height/1 a restore that moves the body along its floor (its spot taken) also stands it at the floor',()=>{
  const e=deck(true);e.world.entities.other=m.human('other',9,-2.6,{level:1,y:DECK});
  const b=e.world.entities.body;
  assert.equal(e.restoreHumanPoseV1('body',{p:[9,.5,-2.6],level:1}),true);
  assert.equal(b.human!.level,1);assert.ok(Math.hypot(b.pose.p[0]-9,b.pose.p[2]+2.6)>.3,'moved off the taken spot');
  assert.ok(Math.abs(b.pose.p[1]-DECK)<1e-9,`on the deck floor: ${b.pose.p[1]}`);
});

for(const policy of [false,true])
  test(`#1454 a stall release upstairs of a body off its floor's height ${policy?'stands it on its floor':'keeps that height (as recorded)'}`,()=>{
    const e=deck(policy),b=e.world.entities.body;
    const r=e.perform({actor:'body',label:'walk',steps:[{verb:'mars:walk_to',params:{x:8.6,z:-1.6,level:1}}]});assert.equal(r.ok,true,JSON.stringify(r));
    e.step();b.pose.p=[b.pose.p[0],.12,b.pose.p[2]];   // the body held off its floor's height (as a climb leaves it)
    const rel=(e as any).stallReleaseV1('body',{code:'stall.released',message:'test'});assert.ok(rel,'released');
    if(policy)assert.ok(Math.abs(b.pose.p[1]-DECK)<1e-9,`on the deck floor: ${b.pose.p[1]}`);
    else assert.equal(b.pose.p[1],.12);
  });
