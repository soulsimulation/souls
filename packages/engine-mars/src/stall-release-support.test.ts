// stall-release-support/1 (#2133, revives #447's fix from #879). On the capacity bench two Souls met head-on on a stair
// flight; one walk was ended and sat cancelling mid-flight, the edge stall guard released it, and the release stood the body
// where it was, off its level's floor: the next tick faulted collision.human-static. body-step-guard/1 (#1332) since stands an
// upstairs body on the nearest clear spot of its floor within 2 m, but with nothing clear there it still releases the body
// where it stands. Under the policy it goes to the nearer clear landing of its flight, else it is not released at all.
// The world is the Eden commons scene (its deck, front flight and ground), with every policy a world adopts at boot.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,type MarsEngine} from './engine.ts';
import {bodyStandsClear} from '../../../mars/viewer/engine/runtime/static-step.ts';
import {acknowledgeRelocation} from '../../../mars/viewer/engine/runtime/invariants.ts';

const factory=await marsFactory({...EDEN_SAFE_COMMONS_WORLD,safeCrewRemoval:true});
const REASON={code:'stall.released',message:'Synthetic stall release (fixture)'};
const BOOT={sleepBlockTicks:1200,bodyStepGuardV1:true,refusalSettleV1:true,stairWayV1:true,standHeightV1:true,standHeightV2:true};
type E=MarsEngine&Record<string,any>;
const rtOf=(e:E)=>(e as unknown as {rt:Parameters<typeof acknowledgeRelocation>[0]}).rt;
const walk=(e:E,id:string,x:number,z:number,level:number)=>{const p=e.perform({actor:id,label:'fixture walk',steps:[{verb:'mars:walk_to',params:{x,z,level}}]});assert.ok(p.ok,JSON.stringify(p));};
const settle=(e:E,id:string)=>{for(let i=0;i<900&&e.programOf(id);i++)e.step();assert.equal(e.programOf(id),null,`${id} arrived`);};
/** The deck's front flight runs from (9, -0.4) on level 0 to its landing at (9, -1.4) on level 1. The descender walks down
 *  from the deck while idle bodies fill the bottom landing, so it waits mid-flight on level 1; its walk is then stopped and
 *  sits cancelling there: the bench's stuck shape. `crowd` then stands idle bodies over all of the deck's clear floor. */
function stuck(seed:string,{policy,crowd}:{policy:boolean;crowd:boolean}){
  const e=factory.create(factory.genesis(seed)) as E;
  e.configureRuntimePolicy({...BOOT,...(policy?{stallReleaseSupportV1:true}:{})} as never);
  e.spawnHuman({id:'mover',label:'Synthetic descender',soul:'fixture'});walk(e,'mover',9,-2.4,1);settle(e,'mover');
  for(const [id,x,z] of [['b1',9,-0.1],['b2',8.6,-0.3],['b3',9.4,-0.3]] as [string,number,number][]){e.spawnHuman({id,label:'Synthetic bottom-landing body',soul:'fixture'});walk(e,id,x,z,0);settle(e,id);}
  walk(e,'mover',9,3,0);
  for(let i=0;i<900&&e.world.entities.mover.human!.activity!=='climb-wait';i++)e.step();
  for(let i=0;i<200;i++)e.step();
  assert.equal(e.world.entities.mover.human!.activity,'climb-wait','waiting mid-flight');assert.equal(e.world.entities.mover.human!.level,1);
  e.stop(e.programOf('mover')!);for(let i=0;i<200;i++)e.step();
  assert.deepEqual(e.stallProbeV1('mover')!.holders.map((h:any)=>h.state),['cancelling'],'a stopped walk still cancelling on the flight');
  if(crowd)for(const [k,[x,z]] of [7.6,8.3,9,9.7,10.4].flatMap(x=>[-1.3,-1.95,-2.6].map(z=>[x,z] as [number,number])).entries()){
    const id=`deck${k}`;e.spawnHuman({id,label:'Synthetic deck body',soul:'fixture'});
    const d=e.world.entities[id];d.pose.p=[x,.24,z];d.human!.level=1;acknowledgeRelocation(rtOf(e),id);   // stood there by hand
  }
  return e;
}
const onFloor=(e:E,id:string)=>{const m=e.world.entities[id];return bodyStandsClear(rtOf(e),m,[m.pose.p[0],m.pose.p[2]],m.human!.level??0);};
const after=(e:E,n:number)=>{const seen=e.runtime.violations.length;for(let i=0;i<n;i++)e.step();return (e.runtime.violations as {code:string;subjects?:string[]}[]).slice(seen).filter(v=>v.subjects?.includes('mover'));};

test('control (body-step-guard/1 alone): with the deck full the release stands the body where it is, mid-flight, off any floor',()=>{
  const e=stuck('stall-support-control',{policy:false,crowd:true}),at=[...e.world.entities.mover.pose.p];
  const r=e.stallReleaseV1('mover',REASON)!;assert.ok(r,'released');
  assert.deepEqual(e.world.entities.mover.pose.p,at,'set down where it was');assert.equal(onFloor(e,'mover'),false,'off its floor');
});

test('policy: the deck full and the bottom landing clear, the release stands the body on the bottom landing; no fault, a restore agrees, it walks on',()=>{
  const e=stuck('stall-support-landing',{policy:true,crowd:true});
  // the bottom landing clears in the same tick (by hand: walking away, the cancelling walk would finish by itself first)
  for(const [id,x] of [['b1',6],['b2',5],['b3',4]] as [string,number][]){const b=e.world.entities[id];b.pose.p=[x,b.pose.p[1],8];acknowledgeRelocation(rtOf(e),id);}
  const r=e.stallReleaseV1('mover',REASON)!;assert.deepEqual(r.released,['walk_to']);
  const m=e.world.entities.mover;assert.deepEqual([m.pose.p[0],m.pose.p[2]],[9,-0.4],'the bottom landing');assert.equal(m.human!.level,0);assert.equal(m.human!.activity,'idle');
  assert.ok(onFloor(e,'mover'),'on its floor');assert.equal(e.programOf('mover'),null);
  const copy=factory.restore(e.snapshot());for(let i=0;i<100;i++){e.step();copy.step();}assert.equal(copy.stateHash(),e.stateHash());
  assert.deepEqual(after(e,100),[]);
  walk(e,'mover',8,3,0);settle(e,'mover');assert.deepEqual(after(e,1),[],'the released body walks on');
});

test('policy: the deck and both landings full, nothing is released: the body stays in its native hold, unmoved, and nothing faults',()=>{
  const e=stuck('stall-support-none',{policy:true,crowd:true}),before=JSON.stringify(e.world.entities.mover.pose.p);
  assert.equal(e.stallReleaseV1('mover',REASON),null);
  assert.equal(JSON.stringify(e.world.entities.mover.pose.p),before,'not moved');
  assert.deepEqual(after(e,100),[]);assert.equal(e.stallProbeV1('mover')!.held,true,'still held, for the guard to name');
});

test('policy is prospective and hashed: a world without it keeps its hash, and a restore keeps it on',()=>{
  const e=factory.create(factory.genesis('stall-support-policy')) as E,before=e.stateHash();
  e.configureRuntimePolicy({sleepBlockTicks:1200,stallReleaseSupportV1:true} as never);const on=e.stateHash();assert.notEqual(on,before);
  const copy=factory.restore(e.snapshot()) as E;assert.equal((copy.snapshot() as any).cfg.stallReleaseSupportV1,true);assert.equal(copy.stateHash(),on);
});
