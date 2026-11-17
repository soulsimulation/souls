// #2596: walkers whose goals touch could wait a minute for each other. One stands at the end of its walk waiting for the
// other to leave its spot (walk.goal-occupied), the other waits for it to get out of the way (traffic.person), or two
// stand face to face; routing round finds nothing in the crowd, so only the one-minute bound ended it (route.blocked).
// Under cycle-recover/1 the deadlock recovery asks a two-body cycle for recovery after 3 s and, when routing round fails,
// one of the pair steps aside and walks on once the other has passed (waits.ts CYCLE_RECOVER_TICKS, walk.ts
// stepAsideInCycle). Without the policy, every tick is as before.
// The scene is N3's jam (#2535): 30 bodies converge on one fire ring from all sides.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,type MarsEngine} from './engine.ts';
import {mutualWaits} from '../../../mars/viewer/engine/runtime/waits.ts';

const factory=await marsFactory();
const N=30,FIRE:[number,number]=[0,-3],MAX_TICKS=4000,SLOT=2*Math.PI/N;
const ids=Array.from({length:N},(_,k)=>`h_jam${String(k).padStart(2,'0')}`);

/** N3's scene: start radius `from`, goal radius `to`, every body turned `rot` of a slot round the fire; cycle-recover/1 `on`. */
function scene(from:number,to:number,rot:number,on=true){
  const w=factory.genesis('replan-budget-jam');
  (w.entities as any).fire={id:'fire',def:'campfire',kind:'fixture',pose:{p:[FIRE[0],0,FIRE[1]],yaw:0},provenance:{source:'fixture'},phase:'installed',support:{kind:'ground'}};
  const e=factory.create(w) as MarsEngine;
  e.configureRuntimePolicy({sleepBlockTicks:1200,...(on?{cycleRecoverV1:true}:{})} as never);
  const at=(k:number,r:number):[number,number]=>{const a=SLOT*(k+rot);return [FIRE[0]+r*Math.cos(a),FIRE[1]+r*Math.sin(a)];};
  ids.forEach((id,k)=>e.spawnHuman({id,soul:'s_'+id,label:`Jam ${k}`,near:{at:at(k,from),first:true}}));
  const progs=new Map<string,string>();
  ids.forEach((id,k)=>{const [x,z]=at(k,to),r=e.perform({actor:id,label:'to the fire',steps:[{verb:'mars:walk_to',params:{x,z}}]});assert.equal(r.ok,true,JSON.stringify(r));progs.set(r.id!,id);});
  return {e,progs};
}
type End={tick:number;kind:string;code?:string};
/** Steps until every walk has ended or MAX_TICKS: each body's end, the longest any body stood in a two-body wait cycle,
 *  and each recovery that stepped a body aside, with the waits of the pair (`mover code / other code`). */
function run(e:MarsEngine,progs:Map<string,string>){
  const rt=(e as any).rt,ends=new Map<string,End>(),since=new Map<string,number>(),asides=new Set<string>();
  let longest=0;
  for(let i=0;i<MAX_TICKS&&ends.size<progs.size;i++){
    const out=e.step();
    for(const p of out.programs)if(progs.has(p.id)&&['completed','failed','cancelled'].includes(p.kind))ends.set(progs.get(p.id)!,{tick:p.tick,kind:p.kind,...(p.code?{code:p.code}:{})});
    for(const id of ids){
      if(mutualWaits(rt,id).length){if(!since.has(id))since.set(id,rt.tick);longest=Math.max(longest,rt.tick-since.get(id)!+1);}
      else since.delete(id);
    }
    for(const w of rt.services.moverWaits?.samples.values()??[])
      if(w.recovery?.diagnostic?.code==='deadlock.stepped-aside'&&w.recovery.completedTick===rt.tick)
        asides.add([w.code,...w.blockers.map((b:string)=>rt.services.moverWaits.samples.get(b)?.code)].join(' / '));
  }
  return {ends,longest,asides};
}
const bound=(ends:Map<string,End>)=>[...ends].filter(([,x])=>x.kind!=='completed').map(([id,x])=>`${id} ${x.kind} ${x.code} at ${x.tick}`);

test('#2596 A1 cycle-recover/1 off: the jam from 10 m to 1.9 m ends three walks by the one-minute bound, tick for tick as on main',()=>{
  const {e,progs}=scene(10,1.9,0,false),{ends,longest,asides}=run(e,progs);
  assert.deepEqual(e.runtime.violations,[]);
  // main 1655b393f, the same scene: h_jam16 waits at its spot for h_jam17, which waits for h_jam16 to move; h_jam25 and
  // h_jam26 each stand on the other's spot; h_jam18 waits for h_jam17. The bound ends three of them at these ticks.
  assert.deepEqual(bound(ends),['h_jam16 failed route.blocked at 1604','h_jam26 failed route.blocked at 1695','h_jam18 failed route.blocked at 1809']);
  assert.equal(Math.max(...[...ends.values()].map(x=>x.tick)),1817,'the last walk ends where it did on main');
  assert.equal(longest,1193,'the longest two-body wait cycle is main\'s');
  assert.deepEqual([...asides],[],'nobody steps aside');
});

test('#2596 cycle-recover/1 is a named state-hash input, absent with the flag off, and set again on restore',()=>{
  const off=factory.create(factory.genesis('cycle-hash')) as MarsEngine,on=factory.create(factory.genesis('cycle-hash')) as MarsEngine;
  off.configureRuntimePolicy({sleepBlockTicks:1200} as never);on.configureRuntimePolicy({sleepBlockTicks:1200,cycleRecoverV1:true} as never);
  assert.notEqual(on.stateHash(),off.stateHash());
  const svc=(x:MarsEngine)=>(x as any).rt.services;
  assert.equal(svc(off).cycleRecoverV1,undefined);assert.equal(svc(on).cycleRecoverV1,true);
  assert.equal(svc(factory.restore(on.snapshot()) as MarsEngine).cycleRecoverV1,true);
});

test('#2596 A1/A2 the jam from 10 m to 1.9 m: the goal-occupied wait cycle is resolved in a few seconds, every body arrives',()=>{
  const {e,progs}=scene(10,1.9,0),{ends,longest,asides}=run(e,progs);
  console.log(`# jam 10 m -> 1.9 m: last walk ended at tick ${Math.max(...[...ends.values()].map(x=>x.tick))}; longest two-body wait cycle ${longest} ticks; stepped aside in ${JSON.stringify([...asides])}`);
  assert.deepEqual(e.runtime.violations,[],'no invariant violations');
  assert.equal(ends.size,N,'every walk ended');
  // without the policy (the test above): route.blocked by the minute bound for h_jam16, h_jam26 and h_jam18
  assert.deepEqual(bound(ends),[],'no walk ended by the one-minute bound');
  assert.ok([...asides].some((a)=>a.includes('walk.goal-occupied')),'a goal-occupied wait cycle was resolved by a body stepping aside');
  // resolved before the 10-s deadlock report (DEADLOCK_TICKS) would even name it; the minute bound is 1200 ticks
  assert.ok(longest<200,`no body stood in a two-body wait cycle for 10 s (${longest} ticks)`);
});

test('#2596 A3 across the 12 variants of the jam no walk ends by the one-minute bound',()=>{
  const rows:string[]=[],failed:string[]=[];
  for(const from of [8,10])for(const to of [1.9,2.4])for(const rot of [0,1/6,1/3]){
    const {e,progs}=scene(from,to,rot),{ends,longest,asides}=run(e,progs),tag=`${from} m -> ${to} m, turned ${rot.toFixed(2)} slot`;
    rows.push(`${tag}: last end tick ${Math.max(...[...ends.values()].map(x=>x.tick))}, longest two-body cycle ${longest} ticks, stepped aside ${JSON.stringify([...asides])}`);
    assert.ok(longest<200,`no body stood in a two-body wait cycle for 10 s (${tag}: ${longest} ticks)`);
    assert.deepEqual(e.runtime.violations,[],`no invariant violations (${tag})`);
    assert.equal(ends.size,N,`every walk ended (${tag})`);
    for(const b of bound(ends))failed.push(`${tag}: ${b}`);
  }
  console.log(rows.map((r)=>`# ${r}`).join('\n'));
  assert.deepEqual(failed,[],'every body arrives in every variant');
});
