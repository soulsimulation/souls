// #1367 flight-resume/1: a climb force-ended mid-flight (stall-guard/1 releases a body whose deferred stair stop waits on a
// blocked landing) leaves the body standing on the flight, its level a landing's. Every walk from there was planned from the
// floor, dropped the body to it in one tick and was refused motion.teleport (the Tower House stair jam). Under the policy the
// walk resumes the flight from where the body stands. Without it, history computes as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,GREEN_FIELD_WORLD,type MarsEngine} from './engine.ts';
import {loadMars} from './load.ts';
import {clearanceAt} from '../../../mars/viewer/engine/spatial/grid.ts';
import {strandedOnFlight} from '../../../mars/viewer/engine/locomotion/walk.ts';
import {probeBody} from './stall.ts';
import {humanStaticClearance,humanHumanSeparation} from '../../../mars/viewer/engine/runtime/invariants.ts';

const m=await loadMars();
const commons=await marsFactory({...EDEN_SAFE_COMMONS_WORLD,walkBlockV1:true});
const commonsRepair=await marsFactory({...EDEN_SAFE_COMMONS_WORLD,walkBlockV1:true,soulsRepairV1:true});

/** The commons deck's front flight climbs from (9, -0.4) on level 0 to its landing at (9, -1.4) on level 1. The climber's walk
 *  is force-ended halfway up (as stall-guard/1 does), so it stands on the flight at neither landing's height. */
function stranded(policy:boolean,nudge=0){
  const e=commons.create((()=>{const w=commons.genesis('flight-resume') as any;w.entities.climber=m.human('climber',9,.8,{yaw:-Math.PI/2});return w;})()) as MarsEngine;
  if(policy)e.configureRuntimePolicy({sleepBlockTicks:1200,flightResumeV1:true});
  const climb=e.perform({actor:'climber',label:'climb onto the deck',steps:[{verb:'walk_to',params:{to:'commons-deck',standoff:0}}]});assert.equal(climb.ok,true,JSON.stringify(climb));
  const c=e.world.entities.climber;
  for(let i=0;i<300&&!(c.human!.activity==='climb-up'&&c.pose.p[1]>.2);i++){e.step();assert.deepEqual(e.runtime.violations,[]);}
  assert.equal(c.human!.activity,'climb-up','the climber is on the flight');
  assert.ok((e as any).rt.forceCancel(c.human!.task!,{code:'stall.released',message:'test: force-ended mid-flight'}));
  // stood idle on this low flight, the body overlaps the deck's edge on its level-0 grid. Without the policy that is flagged
  // every tick; under it (#1453 review) a body on the flight's profile, all of it within the flight's width, is checked as a
  // climber is, so the repair rules never relocate it and it waits there for its next walk
  if(nudge){c.pose.p=[c.pose.p[0]+nudge,c.pose.p[1],c.pose.p[2]];e.step();(e.runtime.violations as unknown[]).length=0;}   // a release that stands it off the centre line (the move itself is the release's, not under test)
  e.step();assert.deepEqual([...new Set(e.runtime.violations.map((d:any)=>d.code))],policy?[]:['collision.human-static']);(e.runtime.violations as unknown[]).length=0;
  assert.equal(c.human!.level,0);assert.ok(c.pose.p[1]>.2,'left standing on the flight, above its floor');
  return e;
}
const walk=(e:MarsEngine,x:number,z:number,level:number)=>{const r=e.perform({actor:'climber',label:'walk on',steps:[{verb:'mars:walk_to',params:{x,z,level}}]});assert.equal(r.ok,true,JSON.stringify(r));};

test('#1367 without the policy a walk from a body on a flight drops it to the floor in one tick (the fault, as recorded)',()=>{
  const e=stranded(false);walk(e,9,2,0);
  let v:any;for(let i=0;i<5&&!v;i++){e.step();v=e.runtime.violations.find((d:any)=>d.code==='motion.teleport');}
  assert.ok(v,'the first step drops the body to its floor');
  assert.equal(v?.code,'motion.teleport',JSON.stringify(e.runtime.violations));
});

for(const [name,x,z,level,nudge] of [['down to the lawn',9,2,0,0],['up onto the deck',9,-2.2,1,0],['down, from a pose rounded off the path by 0.5 mm',9,2,0,.0005],['down, released 0.25 m off the centre line (as a stall release on a flight does)',9,2,0,.25],['up, released 0.25 m off the centre line',9,-2.2,1,.25]] as const)
  test(`#1367 under flight-resume/1 a stranded climber walks ${name}: it resumes the flight, never jumps, and arrives on the floor`,()=>{
    const e=stranded(true,nudge),c=e.world.entities.climber;walk(e,x,z,level);
    let done=false;
    for(let i=0;i<600&&!done;i++){
      // nothing is flagged on any tick: standing idle on the flight (exempt under the policy), then climbing
      const before=[...c.pose.p];e.step();
      assert.deepEqual(e.runtime.violations,[]);
      assert.ok(Math.hypot(c.pose.p[0]-before[0],c.pose.p[1]-before[1],c.pose.p[2]-before[2])<=.15,`no jump at step ${i}`);
      done=!c.human!.task;
    }
    assert.ok(done,'the walk ended');
    assert.equal(c.human!.level,level);
    assert.ok(Math.hypot(c.pose.p[0]-x,c.pose.p[2]-z)<.3,`arrived: ${JSON.stringify(c.pose.p)}`);
    assert.ok(level===0?c.pose.p[1]<.1:Math.abs(c.pose.p[1]-.24)<.05,`on the floor: ${c.pose.p[1]}`);
  });

test('#1367 flight-resume/1 is prospective, hashed and kept across a snapshot',async()=>{
  const f=await marsFactory(GREEN_FIELD_WORLD),e=f.create(f.genesis('flight-resume-policy')) as MarsEngine,before=e.stateHash();
  assert.equal(Object.hasOwn((e.snapshot() as any).cfg,'flightResumeV1'),false);
  e.configureRuntimePolicy({sleepBlockTicks:1200,flightResumeV1:true});assert.notEqual(e.stateHash(),before);
  const copy=f.restore(e.snapshot()) as MarsEngine;assert.equal((copy as any).rt.services.flightResumeV1,true);
  for(let i=0;i<10;i++){e.step();copy.step();assert.equal(copy.stateHash(),e.stateHash());}
});

test('#1367 a walk from a floor beside a flight plans as it did: the policy changes nothing for a body on its own floor',()=>{
  // at the foot landing, just beside the foot, and on the deck by the top landing: the same route with and without the policy
  for(const [x,z,level,y] of [[9,-.4,0,0],[9.4,-.3,0,0],[9,-1.4,1,.24],[8.6,-1.6,1,.24]] as const){
    const routes=[false,true].map(policy=>{
      const w=commons.genesis('flight-resume-floor') as any;w.entities.walker=m.human('walker',x,z,{level,y});
      const e=commons.create(w) as MarsEngine;if(policy)e.configureRuntimePolicy({sleepBlockTicks:1200,flightResumeV1:true});
      const r=e.perform({actor:'walker',label:'walk',steps:[{verb:'mars:walk_to',params:{x:9,z:3,level:0}}]});assert.equal(r.ok,true,JSON.stringify(r));
      e.step();const ex=[...((e as any).rt.services.walkExecs?.values()??[])].find((q:any)=>q.actor==='walker') as any;
      return JSON.stringify({legs:ex?.route.legs,phase:ex?.phase,climbT:ex?.climbT,pose:e.world.entities.walker.pose});
    });
    assert.equal(routes[1],routes[0],`from (${x}, ${z}) level ${level}`);
  }
});

for(const [name,dz] of [['on the line just up the flight',-.5]] as const)
  test(`#1367 an idle body ${name}, in the way of the step back: the walk climbs down beside the line and completes, so does a cancel`,()=>{
    for(const cancel of [false,true]){
      const e=stranded(true,.25),c=e.world.entities.climber,p=[...c.pose.p];
      e.world.entities.other=m.human('other',p[0]-.3,p[2]+dz,{level:0,y:p[1]});e.step();(e.runtime.violations as unknown[]).length=0;
      walk(e,9,2,0);
      let done=false,beside=0;
      for(let i=0;i<1500&&!done;i++){
        if(cancel&&i===5)(e as any).rt.cancel(c.human!.task!);
        const before=[...c.pose.p];e.step();
        const v=e.runtime.violations.filter((d:any)=>(d.subjects??[]).includes('climber')&&d.code!=='collision.human-static');(e.runtime.violations as unknown[]).length=0;
        assert.deepEqual(v.map((d:any)=>d.code),[],`tick ${i}`);
        assert.ok(Math.hypot(c.pose.p[0]-before[0],c.pose.p[1]-before[1],c.pose.p[2]-before[2])<=.15,`no jump at step ${i}`);
        if(c.pose.p[1]<before[1]-1e-6&&c.pose.p[0]>9.05)beside++;
        done=i>2&&!c.human!.task;
      }
      assert.ok(done,`${cancel?'the cancel':'the walk'} ended`);
      assert.ok(beside>0,'it climbed down beside the line while the step back was blocked');
      assert.ok(c.pose.p[1]<.01||Math.abs(c.pose.p[1]-.24)<.05,`on a floor: ${c.pose.p[1]}`);
    }
  });

/** A climber walking down from the deck, stopped by a stall release partway down the flight (level 1, at neither landing's
 *  height). `blockers`: bodies stood idle once it is on the flight (level, x, z, y). */
function releasedOnFlight(policy:boolean,blockers:[number,number,number,number][]=[],repair=false){
  const f=repair?commonsRepair:commons,w=f.genesis('flight-release') as any;w.entities.climber=m.human('climber',9,-2.2,{level:1,y:.24,yaw:Math.PI/2});
  const e=f.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,...(policy?{flightResumeV1:true}:{}),...(repair?{refusalSettleV1:true}:{})});
  const r=e.perform({actor:'climber',label:'down to the lawn',steps:[{verb:'mars:walk_to',params:{x:9,z:2,level:0}}]});assert.equal(r.ok,true,JSON.stringify(r));
  const c=e.world.entities.climber;
  for(let i=0;i<400&&!(c.human!.activity==='climb-down'&&c.pose.p[1]<.18);i++)e.step();
  assert.equal(c.human!.activity,'climb-down','the climber is on the flight');
  // only where that floor is open (none under the deck, where no one stands)
  const sp=(e as any).rt.services.spatial;sp.sync(e.world);
  blockers.filter(([level,x,z])=>clearanceAt(sp.levelAt(level,[x,z]),[x,z])>.2).forEach(([level,x,z,y],i)=>{e.world.entities[`b${i}`]=m.human(`b${i}`,x,z,{level,y});});
  const before=[...c.pose.p],rel=(e as any).stallReleaseV1('climber',{code:'stall.released',message:'test: released mid-flight'});
  assert.ok(rel,'released');(e.runtime.violations as unknown[]).length=0;
  return {e,c,before,blockers:Object.keys(e.world.entities).filter(id=>/^b\d+$/.test(id))};
}

test('#1367 without flight-resume/1 a stall release on a flight keeps the flight height on a floor cell (the fault, as recorded)',()=>{
  const {c}=releasedOnFlight(false);
  assert.equal(c.human!.level,1);
  assert.ok(Math.abs(c.pose.p[1]-.24)>.03,`stood on level 1 at a height that is not its floor's: ${c.pose.p[1]}`);
});

test('#1367 under flight-resume/1 a stall release on a flight stands the body on the nearer landing, at that floor, and it walks on',()=>{
  const {e,c}=releasedOnFlight(true);
  assert.equal(c.human!.level,0);assert.ok(Math.abs(c.pose.p[1])<1e-9,`at the foot's floor height: ${c.pose.p[1]}`);
  assert.ok(Math.hypot(c.pose.p[0]-9,c.pose.p[2]+.4)<=2,'near the foot landing');
  walk(e,9,2,0);
  let done=false;
  for(let i=0;i<600&&!done;i++){const b=[...c.pose.p];e.step();
    assert.deepEqual(e.runtime.violations.filter((d:any)=>(d.subjects??[]).includes('climber')).map((d:any)=>d.code),[],`tick ${i}`);
    assert.ok(Math.hypot(c.pose.p[0]-b[0],c.pose.p[1]-b[1],c.pose.p[2]-b[2])<=.15,`no jump at step ${i}`);done=i>0&&!c.human!.task;}
  assert.ok(done,'the walk ended');assert.ok(Math.hypot(c.pose.p[0]-9,c.pose.p[2]-2)<.3,`arrived: ${JSON.stringify(c.pose.p)}`);
});

test('#1367 under flight-resume/1 a release whose nearer landing is crowded takes the farther one, at its floor',()=>{
  // bodies on the lawn round the foot landing, out past 2 m
  const crowd:[number,number,number,number][]=[];
  for(let x=6.5;x<=11.5;x+=.5)for(let z=-2.4;z<=2.1;z+=.5)crowd.push([0,x,z,0]);
  const {c}=releasedOnFlight(true,crowd);
  assert.equal(c.human!.level,1,JSON.stringify(c.pose.p));assert.ok(Math.abs(c.pose.p[1]-.24)<.03,`on the deck floor: ${c.pose.p[1]}`);
});

test('#1367 under flight-resume/1 a release with both landings crowded leaves the body where it stands on the flight',()=>{
  const crowd:[number,number,number,number][]=[];
  for(let x=6.5;x<=11.5;x+=.5){for(let z=-2.4;z<=2.1;z+=.5)crowd.push([0,x,z,0]);for(let z=-1.4;z>=-3.9;z-=.5)crowd.push([1,x,z,.24]);}
  const {c,before}=releasedOnFlight(true,crowd);
  assert.deepEqual(c.pose.p.map(v=>+v.toFixed(3)),before.map(v=>+v.toFixed(3)),'not moved');assert.equal(c.human!.level,1);
});

// #1367 sign-off bounds (maintainer, via the coordinator): the eject is a stall release's only, at most 4 m (the way along the
// flight to the landing plus the search ring); past that the body stays on the flight. The ended programme says it was moved.
function releaseAt(t:number,total:number){
  const w=commons.genesis('flight-release') as any;w.entities.climber=m.human('climber',9,-2.2,{level:1,y:.24,yaw:Math.PI/2});
  const e=commons.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,flightResumeV1:true});
  const r=e.perform({actor:'climber',label:'down to the lawn',steps:[{verb:'mars:walk_to',params:{x:9,z:2,level:0}}]});assert.equal(r.ok,true,JSON.stringify(r));
  const c=e.world.entities.climber,rt=(e as any).rt;
  for(let i=0;i<400&&!(c.human!.activity==='climb-down'&&c.pose.p[1]<.18);i++)e.step();
  const flight=strandedOnFlight(rt,c as any);assert.ok(flight,'on the flight');
  // the same flight, as if it were longer: the body this far along it from the foot, and that far from the top
  const before=[...c.pose.p],rel=(e as any).releaseFromFlightV1('climber',c,probeBody(rt,'climber'),{...flight,t,total},{code:'stall.released',message:'test: released mid-flight'});
  const ends=e.step().programs.filter((p:any)=>p.kind!=='step');
  return {c,before,rel,ends};
}
test('#1367 under flight-resume/1 a release never moves a body more than 4 m: past that it stays on the flight',()=>{
  const far=releaseAt(4.5,9);
  assert.deepEqual(far.c.pose.p.map(v=>+v.toFixed(3)),far.before.map(v=>+v.toFixed(3)),'not moved: both landings are farther than 4 m');
  const near=releaseAt(.5,1.05);
  assert.ok(Math.hypot(near.c.pose.p[0]-near.before[0],near.c.pose.p[2]-near.before[2])>.05,'moved to a landing within the bound');
  assert.ok(near.ends.some((p:any)=>/Moved off the flight to the landing \(\d+\.\d m\)/.test(p.message??p.reason?.message??'')),`the ended programme says so: ${JSON.stringify(near.ends).slice(0,300)}`);
});

// #1453 review (a): the 4 m bound is on the body's real one-tick move, measured from where it stands (off the centre line too),
// and the figure the Soul is told is that move
test('#1453 a release off the centre line reports the body\'s real move, not the way along the line',()=>{
  const w=commons.genesis('flight-release') as any;w.entities.climber=m.human('climber',9,-2.2,{level:1,y:.24,yaw:Math.PI/2});
  const e=commons.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,flightResumeV1:true});
  assert.equal(e.perform({actor:'climber',label:'down',steps:[{verb:'mars:walk_to',params:{x:9,z:2,level:0}}]}).ok,true);
  const c=e.world.entities.climber,rt=(e as any).rt;
  for(let i=0;i<400&&!(c.human!.activity==='climb-down'&&c.pose.p[1]<.18);i++)e.step();
  c.pose.p=[c.pose.p[0]+.4,c.pose.p[1],c.pose.p[2]];   // stood 0.4 m off the centre line, still on the flight's width
  const flight=strandedOnFlight(rt,c as any);assert.ok(flight,'on the flight');
  const before=[...c.pose.p],rel=(e as any).releaseFromFlightV1('climber',c,probeBody(rt,'climber'),flight,{code:'stall.released',message:'test'});
  assert.ok(rel);const ends=e.step().programs.filter((p:any)=>p.kind!=='step');
  const real=Math.hypot(c.pose.p[0]-before[0],c.pose.p[1]-before[1],c.pose.p[2]-before[2]),msg=JSON.stringify(ends);
  const said=Number(/Moved off the flight to the landing \((\d+\.\d) m\)/.exec(msg)?.[1]);
  assert.ok(Math.abs(said-real)<=.051,`told ${said} m, moved ${real.toFixed(3)} m: ${msg.slice(0,300)}`);
  assert.ok(real>Math.min(flight!.t,flight!.total-flight!.t)+.05,'the real move is longer than the way along the line');
});
test('#1453 a landing spot more than 4 m from where the body really stands is refused, whatever the way along the line',()=>{
  const w=commons.genesis('flight-release') as any;w.entities.climber=m.human('climber',9,-2.2,{level:1,y:.24,yaw:Math.PI/2});
  const e=commons.create(w) as MarsEngine;e.configureRuntimePolicy({sleepBlockTicks:1200,bodyStepGuardV1:true,flightResumeV1:true});
  assert.equal(e.perform({actor:'climber',label:'down',steps:[{verb:'mars:walk_to',params:{x:9,z:2,level:0}}]}).ok,true);
  const c=e.world.entities.climber,rt=(e as any).rt;
  for(let i=0;i<400&&!(c.human!.activity==='climb-down'&&c.pose.p[1]<.18);i++)e.step();
  const flight=strandedOnFlight(rt,c as any);assert.ok(flight&&Math.min(flight.t,flight.total-flight.t)<1,'the way along the line is under 1 m');
  // the same flight, with the body 6.5 m to its side: every landing spot (within 2 m of a landing) is over 4 m away
  c.pose.p=[c.pose.p[0]+6.5,c.pose.p[1],c.pose.p[2]];
  const before=[...c.pose.p];(e as any).releaseFromFlightV1('climber',c,probeBody(rt,'climber'),flight,{code:'stall.released',message:'test'});
  assert.deepEqual(c.pose.p,before,'not moved');
});

// #1453 review (b): the stay-on-the-flight fallback holds under the repair rules every server world runs (souls-repair/1 and
// hold-settle/1): no relocation, no settle, no static flag; the Soul is told why it stayed, and its next walk resumes the flight
test('#1453 under the repair rules a body left on the flight stays there, is told why, and its next walk resumes the flight',()=>{
  const crowd:[number,number,number,number][]=[];
  for(let x=6.5;x<=11.5;x+=.5){for(let z=-2.4;z<=2.1;z+=.5)crowd.push([0,x,z,0]);for(let z=-1.4;z>=-3.9;z-=.5)crowd.push([1,x,z,.24]);}
  const {e,c,before,blockers}=releasedOnFlight(true,crowd,true);
  assert.equal((e as any).cfg.soulsRepairV1,true);assert.equal((e as any).cfg.refusalSettleV1,true);
  const ends=e.step().programs.filter((p:any)=>p.kind!=='step');
  assert.ok(/Left standing on the flight: no clear landing within 4 m; the next walk resumes the flight from here\./.test(JSON.stringify(ends)),`told why it stayed: ${JSON.stringify(ends).slice(0,300)}`);
  for(let i=0;i<60;i++){e.step();
    assert.deepEqual(e.runtime.violations.filter((d:any)=>(d.subjects??[]).includes('climber')).map((d:any)=>d.code),[],`tick ${i}`);
    assert.deepEqual(c.pose.p.map(v=>+v.toFixed(3)),before.map(v=>+v.toFixed(3)),`still where it stood at tick ${i}`);}
  assert.equal(c.human!.level,1);
  for(const id of blockers)delete e.world.entities[id];   // the crowd goes; the body walks on from the flight
  walk(e,9,2,0);let done=false;
  for(let i=0;i<600&&!done;i++){const b=[...c.pose.p];e.step();
    assert.deepEqual(e.runtime.violations.filter((d:any)=>(d.subjects??[]).includes('climber')).map((d:any)=>d.code),[],`walk tick ${i}`);
    assert.ok(Math.hypot(c.pose.p[0]-b[0],c.pose.p[1]-b[1],c.pose.p[2]-b[2])<=.15,`no jump at step ${i}`);done=i>0&&!c.human!.task;}
  assert.ok(done,'the walk ended');assert.equal(c.human!.level,0);assert.ok(Math.hypot(c.pose.p[0]-9,c.pose.p[2]-2)<.3,`arrived: ${JSON.stringify(c.pose.p)}`);
});

// #1453 kernel exemption, kept tight: only on the flight's profile, all of the body within its width, and only under the policy;
// another body is still kept apart
test('#1453 the static check exempts only a body on the flight\'s profile and within its width, under the policy; bodies stay apart',()=>{
  const flagged=(e:MarsEngine)=>humanStaticClearance((e as any).rt).some((d:any)=>d.subjects.includes('climber'));
  const e=stranded(true),c=e.world.entities.climber,p=[...c.pose.p] as [number,number,number];
  assert.equal(flagged(e),false,'on the flight: checked as a climber');
  for(const [what,q] of [['0.1 m above the flight\'s profile',[p[0],p[1]+.1,p[2]]],['0.3 m further up the flight at the same height (off its profile)',[p[0],p[1],p[2]-.3]],['0.35 m to the side, reaching past the flight\'s edge',[p[0]+.35,p[1],p[2]]]] as const){
    c.pose.p=[...q] as [number,number,number];
    const g=(e as any).rt.services.spatial.levelAt(0,[q[0],q[2]]);
    assert.ok(g&&clearanceAt(g,[q[0],q[2]])<.25,`${what}: inside geometry on its level grid`);
    assert.equal(flagged(e),true,`${what}: still flagged`);
  }
  c.pose.p=[...p];
  const off=stranded(false);assert.equal(flagged(off),true,'without the policy the stranded body is flagged, as recorded');
  e.world.entities.other=m.human('other',p[0]+.1,p[2],{level:0,y:p[1]});
  assert.ok(humanHumanSeparation((e as any).rt).some((d:any)=>d.subjects.includes('climber')&&d.subjects.includes('other')),'two bodies on the flight are still kept apart');
});

// #1453 known limit, pinned: the exemption ends where the body reaches past the flight's width (offset + radius > width/2 +
// 0.05; on this 1 m flight with a 0.28 m body, 0.27 m off the line). Past that the body is checked as any body, so under the
// repair rules its relocation is the repair's own (nearestStandV1), not the capped landing search. The release never stands a
// body there under the policy; such a body comes from an older history or an off-line climb force-ended at that offset.
test('#1453 known limit: a body more than 0.27 m off this 1 m flight\'s line is checked as any body (the repair, uncapped, may move it)',()=>{
  const flagged=(e:MarsEngine)=>humanStaticClearance((e as any).rt).some((d:any)=>d.subjects.includes('climber'));
  const e=stranded(true),c=e.world.entities.climber,p=[...c.pose.p] as [number,number,number];
  for(const [off,want] of [[.26,false],[.27,false],[.28,true],[.3,true]] as const){c.pose.p=[p[0]+off,p[1],p[2]];assert.equal(flagged(e),want,`${off} m off the line`);}
});

test('#1453 under flight-resume/1 a release stands the body clear of every flight end on its landing level, not on the point where climbers step on and off',()=>{
  const {e,c}=releasedOnFlight(true);
  const sp=(e as any).rt.services.spatial;sp.sync((e as any).rt.world);
  const r=(e as any).bodyRadiusV1(c);
  const ends=sp.scene.links.filter((l:any)=>l.usable).flatMap((l:any)=>[l.from,l.to]).filter((q:any)=>q.level===c.human!.level);
  assert.ok(ends.length>0,'the landing level has flight ends');
  for(const q of ends)assert.ok(Math.hypot(q.p[0]-c.pose.p[0],q.p[1]-c.pose.p[2])>=2*r-1e-9,`clear of the flight end at ${JSON.stringify(q.p)}: ${JSON.stringify(c.pose.p)}`);
});
