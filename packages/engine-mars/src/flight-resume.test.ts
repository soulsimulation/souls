// #1367 flight-resume/1: a climb force-ended mid-flight (stall-guard/1 releases a body whose deferred stair stop waits on a
// blocked landing) leaves the body standing on the flight, its level a landing's. Every walk from there was planned from the
// floor, dropped the body to it in one tick and was refused motion.teleport (the Tower House stair jam). Under the policy the
// walk resumes the flight from where the body stands. Without it, history computes as recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_SAFE_COMMONS_WORLD,GREEN_FIELD_WORLD,type MarsEngine} from './engine.ts';
import {loadMars} from './load.ts';

const m=await loadMars();
const commons=await marsFactory({...EDEN_SAFE_COMMONS_WORLD,walkBlockV1:true});

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
  // stood idle on this low flight, the body overlaps the deck's edge on its level-0 grid: the stranded state itself is flagged
  // (an idle body is not exempt as a climber is); that is the state the walk must recover from, so it is cleared here
  if(nudge){c.pose.p=[c.pose.p[0]+nudge,c.pose.p[1],c.pose.p[2]];e.step();(e.runtime.violations as unknown[]).length=0;}   // a release that stands it off the centre line (the move itself is the release's, not under test)
  e.step();assert.deepEqual([...new Set(e.runtime.violations.map((d:any)=>d.code))].filter(c=>c!=='collision.human-static'),[]);(e.runtime.violations as unknown[]).length=0;
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
      // the tick the walk is admitted the body still stands idle where it was stranded (the flag cleared above); from the next
      // tick it climbs and nothing is flagged
      const before=[...c.pose.p];e.step();
      if(i===0){assert.deepEqual(e.runtime.violations.map((d:any)=>d.code),['collision.human-static']);(e.runtime.violations as unknown[]).length=0;}
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
      const e=stranded(true,.3),c=e.world.entities.climber,p=[...c.pose.p];
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
