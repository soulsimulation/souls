// #2426 cede-passage/1: a walker at the end of its walk leg does not take up a single-file passage it does not hold while the
// body standing on its destination is yielding to it (W38's own test). The proving ground's 1.0 m passage at x=15 in the wall
// along z=-15: an arriver A walks to a spot in the passage where an occupant X stands; X is asked to make way through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,type MarsEngine} from './engine.ts';

const factory=await marsFactory();
const X='h_occupant0',A='h_arriver00',C='h_oncoming0';
const execOf=(e:MarsEngine,actor:string):any=>[...((e as any).rt.services.walkExecs?.values()??[])].find((x:any)=>x.actor===actor);
const recOf=(e:MarsEngine,id:string|undefined)=>id?(e as any).rt.records.get(id):undefined;

function scene(on:boolean){
  const e=factory.create(factory.genesis('cede-passage')) as MarsEngine;
  e.configureRuntimePolicy({sleepBlockTicks:1200,...(on?{cedePassageV1:true}:{})} as never);
  e.spawnHuman({id:X,soul:'s_'+X,label:'Occupant',near:{at:[15.4,-14.5],first:true}});
  e.spawnHuman({id:A,soul:'s_'+A,label:'Arriver',near:{at:[19,-17],first:true}});
  e.spawnHuman({id:C,soul:'s_'+C,label:'Oncoming',near:{at:[13,-11],first:true}});
  const r=e.perform({actor:A,label:'to the spot',steps:[{verb:'mars:walk_to',params:{x:15,z:-14.8}}]});assert.equal(r.ok,true,JSON.stringify(r));
  return {e,id:r.id!};
}
/** One line per tick: every body's pose, A's walk (progress, holds, status, code) and who holds what. */
function trace(e:MarsEngine){
  const ex=execOf(e,A),rec=recOf(e,ex?.id),x=recOf(e,e.world.entities[X].human?.task),traffic=(e as any).rt.services.traffic??new Map();
  return JSON.stringify([e.world.tick,[A,X,C].map(id=>e.world.entities[id].pose.p.map(v=>+v.toFixed(4))),ex?[+ex.s.toFixed(4),[...ex.held],rec?.status,rec?.diagnostic?.code??null]:null,
    x?[x.status,x.diagnostic?.code??null,x.diagnostic?.subjects??null]:null,[...traffic.entries()].map(([k,v]:any)=>[k,[...v.actors]])]);
}
/** Steps until X's make-way walk is yielding to A while A, at the end of its leg, holds the passage (W38's moment). */
function untilYieldsToA(e:MarsEngine){
  for(let i=0;i<400;i++){
    const ex=execOf(e,A),x=recOf(e,e.world.entities[X].human?.task);
    if(ex&&ex.s>=ex.total-1e-6&&ex.held.size&&x?.status==='blocked'&&x.diagnostic?.code==='traffic.yield'&&x.diagnostic.subjects?.includes(A))return ex;
    e.step();
  }
  assert.fail('X never yielded to A');
}

test('#2426 the ordinary W38 hand-off is unchanged: with and without cede-passage/1 the same walk, tick for tick, and A arrives',()=>{
  const runs=[false,true].map(on=>{const {e,id}=scene(on),lines:string[]=[];let done=0;
    for(let i=0;i<900&&!done;i++){e.step();lines.push(trace(e));if(e.programOf(A)!==id)done=e.world.tick;}
    assert.ok(done,'A reached its spot');assert.deepEqual(e.runtime.violations,[]);return lines;});
  assert.deepEqual(runs[1],runs[0]);
});

test('#2426 the mechanism: a walker at its spot whose occupant yields to it does not queue for the passage behind another body',()=>{
  // A has just let the passage go (W38) and the oncoming C has taken it before X stepped in: without the rule A queues behind C
  // for a passage it no longer needs (traffic.yield); with it A goes on waiting for X to clear its spot, and X goes on through
  const codes=[false,true].map(on=>{const {e}=scene(on),ex=untilYieldsToA(e),traffic=(e as any).rt.services.traffic;
    const res=[...ex.held][0];ex.held.clear();const t0=traffic.get(res);traffic.set(res,{...t0,dir:[-t0.dir[0],-t0.dir[1]],actors:new Set([C])});
    e.step();const rec=recOf(e,ex.id);return [rec.diagnostic?.code,[...ex.held].length];});
  assert.deepEqual(codes[0],['traffic.yield',0],'without the rule A takes up the passage again and waits behind C');
  assert.deepEqual(codes[1],['walk.goal-occupied',0],'with it A leaves the passage alone');
});

test('#2426 C→A→X: when the body on A\'s spot yields to someone else, A behaves exactly as without the rule',()=>{
  // the review's case: A stands at its spot, an oncoming C holds the passage, and X, leaving through it, yields to C (not to A)
  const runs=[false,true].map(on=>{const {e}=scene(on),ex=untilYieldsToA(e),traffic=(e as any).rt.services.traffic,res=[...ex.held][0],t0=traffic.get(res),xn=execOf(e,X).narrows.find((n:any)=>n.res===res),lines:string[]=[];
    ex.held.clear();
    // C holds the passage for the whole run, coming the other way to X (an oncoming walker inside it)
    for(let i=0;i<300;i++){traffic.set(res,{entry:t0.entry,dir:[-xn.dir[0],-xn.dir[1]],actors:new Set([C])});e.step();lines.push(trace(e));}
    const x=recOf(e,e.world.entities[X].human?.task);assert.deepEqual(x?.diagnostic?.subjects,[X,C],`X waits for C: ${x?.diagnostic?.code}`);
    return lines;});
  assert.deepEqual(runs[1],runs[0]);
});

test('#2426 cede-passage/1 is a named state-hash input, absent with the flag off',()=>{
  const off=factory.create(factory.genesis('cede-hash')) as MarsEngine,on=factory.create(factory.genesis('cede-hash')) as MarsEngine;
  on.configureRuntimePolicy({sleepBlockTicks:1200,cedePassageV1:true} as never);off.configureRuntimePolicy({sleepBlockTicks:1200} as never);
  assert.notEqual(on.stateHash(),off.stateHash());
  assert.equal((off as any).rt.services.cedePassageV1,undefined);assert.equal((on as any).rt.services.cedePassageV1,true);
});
