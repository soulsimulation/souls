// #2535 replan-budget/1: a walker blocked by people re-plans around them only within the per-tick re-plan budget (walk.ts
// takeReplan), waits a tick when it is spent, and re-plans forced once refused REPLAN_PEOPLE_WAIT ticks past its decision.
// The jam: 30 bodies converge on one fire ring from all sides, in the proving ground's open middle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,type MarsEngine} from './engine.ts';

const factory=await marsFactory();
const N=30,FIRE:[number,number]=[0,-3],FROM=8,TO=1.9,MAX_TICKS=4000;
const ids=Array.from({length:N},(_,k)=>`h_jam${String(k).padStart(2,'0')}`);
const services=(e:MarsEngine):any=>(e as any).rt.services;

function scene(on:boolean){
  const w=factory.genesis('replan-budget-jam');
  (w.entities as any).fire={id:'fire',def:'campfire',kind:'fixture',pose:{p:[FIRE[0],0,FIRE[1]],yaw:0},provenance:{source:'fixture'},phase:'installed',support:{kind:'ground'}};
  const e=factory.create(w) as MarsEngine;
  e.configureRuntimePolicy({sleepBlockTicks:1200,...(on?{replanBudgetV1:true}:{})} as never);
  ids.forEach((id,k)=>{const a=2*Math.PI*k/N;e.spawnHuman({id,soul:'s_'+id,label:`Jam ${k}`,near:{at:[FIRE[0]+FROM*Math.cos(a),FIRE[1]+FROM*Math.sin(a)],first:true}});});
  const progs=new Map<string,string>();
  ids.forEach((id,k)=>{const a=2*Math.PI*k/N,r=e.perform({actor:id,label:'to the fire',steps:[{verb:'mars:walk_to',params:{x:FIRE[0]+TO*Math.cos(a),z:FIRE[1]+TO*Math.sin(a)}}]});assert.equal(r.ok,true,JSON.stringify(r));progs.set(r.id!,id);});
  return {e,progs};
}
type End={tick:number;kind:string;code?:string};
/** Steps until every walk has ended, MAX_TICKS, or tick `until`; each body's end. */
function run(e:MarsEngine,progs:Map<string,string>,until=Infinity){
  const ends=new Map<string,End>();
  for(let i=0;i<MAX_TICKS&&ends.size<progs.size&&e.world.tick<until;i++){
    const out=e.step();
    for(const p of out.programs)if(progs.has(p.id)&&['completed','failed','cancelled'].includes(p.kind))ends.set(progs.get(p.id)!,{tick:p.tick,kind:p.kind,...(p.code?{code:p.code}:{})});
  }
  return ends;
}

test('#2535 A1 the jam, rule off and on: every body arrives or is refused by name, none is still blocked at the end, and with the rule no tick has more than 4 non-forced re-plans',()=>{
  const res=[false,true].map(on=>{const {e,progs}=scene(on),ends=run(e,progs),arm=on?'on':'off';
    assert.deepEqual(e.runtime.violations,[],`no invariant violations (${arm})`);
    const open=ids.filter(id=>!ends.has(id));
    assert.deepEqual(open,[],`every body's walk ended (${arm}); still going: ${open.map(id=>`${id} ${e.world.entities[id].human?.activity}`).join(', ')}`);
    for(const [id,x] of ends)assert.ok(x.kind==='completed'||(x.kind==='failed'&&!!x.code),`${id} arrived or was refused by name (${arm}): ${JSON.stringify(x)}`);
    const c=services(e).replanCount,b=services(e).replanBudget;
    return {last:Math.max(...[...ends.values()].map(x=>x.tick)),arrived:[...ends.values()].filter(x=>x.kind==='completed').length,refused:[...ends].filter(([,x])=>x.code).map(([id,x])=>`${id} ${x.code} at ${x.tick}`),freePeak:c?.freePeak??0,freeMulti:c?.freeMulti??0,deferred:b?.deferred??0};});
  for(const [arm,r] of [['off',res[0]],['on',res[1]]] as const)
    console.log(`# jam ${arm}: last walk ended at tick ${r.last}; ${r.arrived}/${N} arrived; refused ${JSON.stringify(r.refused)}; non-forced re-plans: most in one tick ${r.freePeak}, ticks with more than one ${r.freeMulti}; walker-ticks refused the budget ${r.deferred}`);
  assert.ok(res[0].freePeak>4,`the jam without the rule puts more than 4 re-plans in one tick (${res[0].freePeak})`);
  assert.ok(res[1].freePeak<=4,`at most 4 non-forced re-plans in a tick with the rule (${res[1].freePeak})`);
  assert.ok(res[1].deferred>0,'with the rule some walkers waited their turn');
});

test('#2535 A2 fault-replay: a world restored from a snapshot mid-jam reaches the same state hash as one that ran straight through',()=>{
  const straight=scene(true),split=scene(true);
  run(straight.e,straight.progs,400);
  run(split.e,split.progs,200);
  const copy=factory.restore(JSON.parse(JSON.stringify(split.e.snapshot()))) as MarsEngine;
  assert.equal(copy.stateHash(),split.e.stateHash(),'the restore itself is exact');
  run(copy,split.progs,400);
  assert.ok(services(straight.e).replanBudget.deferred>0,'by tick 400 the jam had walkers waiting their turn');
  assert.equal(copy.world.tick,straight.e.world.tick);
  assert.equal(copy.stateHash(),straight.e.stateHash());
});

test('#2535 replan-budget/1 is a named state-hash input, absent with the flag off, and set again on restore',()=>{
  const off=factory.create(factory.genesis('replan-hash')) as MarsEngine,on=factory.create(factory.genesis('replan-hash')) as MarsEngine;
  on.configureRuntimePolicy({sleepBlockTicks:1200,replanBudgetV1:true} as never);off.configureRuntimePolicy({sleepBlockTicks:1200} as never);
  assert.notEqual(on.stateHash(),off.stateHash());
  assert.equal(services(off).replanBudgetV1,undefined);assert.equal(services(on).replanBudgetV1,true);
  assert.equal(services(factory.restore(on.snapshot()) as MarsEngine).replanBudgetV1,true);
});
