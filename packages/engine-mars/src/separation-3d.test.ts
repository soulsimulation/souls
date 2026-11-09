// #1455 body-separation-3d/1: the engine's placements (restore, settle, stall release) kept a placed body apart only from bodies
// of the same level id, by distance on the ground plan. A climber on a flight carries a landing's level id, so a body placed at
// the other landing could be stood inside it; a body of the same level id on another storey blocked a spot it never touches.
// Under the policy the check reads height: bodies whose height overlaps, whatever their level id. Without it, as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,type MarsEngine} from './engine.ts';
import {loadMars} from './load.ts';

const m=await loadMars();
const commons=await marsFactory({...EDEN_SAFE_COMMONS_WORLD,walkBlockV1:true});
const DECK=.24;   // the commons deck (level 1) floor height; its front flight climbs from (9, -0.4) to the landing at (9, -1.4)

function world(policy:boolean,others:Record<string,[number,number,number,number]>,body:[number,number,number,number]){
  const w=commons.genesis('separation-3d') as any;
  w.entities.body=m.human('body',body[1],body[2],{level:body[0],y:body[3]});
  for(const [id,[level,x,z,y]] of Object.entries(others))w.entities[id]=m.human(id,x,z,{level,y});
  const e=commons.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,...(policy?{separation3dV1:true}:{})});
  return e;
}
const apart=(e:MarsEngine,a:string,b:string)=>{const p=e.world.entities[a].pose.p,q=e.world.entities[b].pose.p;return Math.hypot(p[0]-q[0],p[2]-q[2]);};

for(const policy of [false,true])
  test(`#1455 a restore to the top landing beside a climber of the other level id ${policy?'keeps clear of it':'stands inside it (as recorded)'}`,()=>{
    // the climber near the top of the flight carries the foot's level id (0), at almost the deck's height
    const e=world(policy,{climber:[0,9,-1.25,.2]},[1,9,-2.6,DECK]);
    assert.equal(e.restoreHumanPoseV1('body',{p:[9,DECK,-1.4],level:1}),true);
    const b=e.world.entities.body;assert.equal(b.human!.level,1);
    if(policy)assert.ok(apart(e,'body','climber')>=.5,`apart: ${apart(e,'body','climber')}`);
    else assert.deepEqual([b.pose.p[0],b.pose.p[2]],[9,-1.4],'stood at the pose, 0.15 m from the climber');
  });

for(const policy of [false,true])
  test(`#1455 a stall release on the deck under a body of the same level id far above ${policy?'stays where it is':'is moved off (as recorded)'}`,()=>{
    const e=world(policy,{above:[1,9,-2.6,3]},[1,9,-2.6,DECK]);
    const r=e.perform({actor:'body',label:'walk',steps:[{verb:'mars:walk_to',params:{x:8.6,z:-1.6,level:1}}]});assert.equal(r.ok,true,JSON.stringify(r));
    e.step();const at=[...e.world.entities.body.pose.p];
    assert.ok((e as any).stallReleaseV1('body',{code:'stall.released',message:'test'}),'released');
    const p=e.world.entities.body.pose.p,moved=Math.hypot(p[0]-at[0],p[2]-at[2]);
    if(policy)assert.ok(moved<1e-3,`not moved: ${moved}`);else assert.ok(moved>.3,`moved: ${moved}`);
  });
