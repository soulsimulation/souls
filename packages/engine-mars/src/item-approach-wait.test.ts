// #2155 wait-bound/3: a take_item / put_item walks to its stand as a child walk_to, and the item's own record reads `running`
// the while. wait-bound/1 reads the program record's verb (take_item), so a held approach was never bounded: its receipt
// stayed `started` and the Soul froze. wait-bound/3 runs the same bound against the approach walk and stops only it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCampDrinkFactory} from './drink-engine.ts';
import type {MarsEngine} from './engine.ts';
import type {ProgramEvent} from '@souls/engine-contract';

const A='actor',B='h_block0000';
const walkOf=(e:MarsEngine):any=>[...((e as any).rt.services.walkExecs?.values()??[])].find((x:any)=>x.actor===A);

/** The camp drink fixture: the actor walks about 25 m to the water bowl, its route through one narrow way. */
async function take(policy:Record<string,boolean>){
  const f=await nativeCampDrinkFactory(),e=f.create(f.genesis('item-approach-wait')) as unknown as MarsEngine;
  e.configureRuntimePolicy({sleepBlockTicks:1200,itemApproachV1:true,waitBoundV1:true,waitBoundV2:true,...policy} as never);
  e.spawnHuman({id:A,soul:'native-fixture-not-product',label:'Native fixture'});e.spawnHuman({id:B,soul:'native-fixture-not-product',label:'Blocker'});
  const r=e.perform({actor:A,label:'take water bowl',steps:[{verb:'mars:take_item',params:{item:'water-bowl',hand:'left'}}]});assert.equal(r.ok,true,JSON.stringify(r));
  return {e,id:r.id!};
}
/** Steps the scene. With `hold`, a body (B) holds the approach walk's narrow way for good, as a walker inside it would, and
 *  B shuffles by 2 mm a tick, as a body in a crowd does (and as a walker yielding beside a wall rocks, wait-bound.test.ts):
 *  that restarts the persistent-wait detector, so the hold is never named a deadlock. item-approach/1's limit reads a deadlock
 *  name, or any blocked approach only where walk-block/1 is on (off here); the take's own record reads `running` throughout. */
function run(e:MarsEngine,id:string,ticks:number,hold:boolean){
  const rt=(e as any).rt,events:ProgramEvent[]=[];let held=false,parent:string|undefined;
  // headway: the last tick the body left a 0.5 m disc round where it last made headway (the watchdog's measure)
  let anchor=[...e.world.entities[A].pose.p],headway=e.world.tick;
  for(let i=0;i<ticks&&e.programOf(A)===id;i++){
    events.push(...e.step().programs);
    const ex=walkOf(e),a=e.world.entities[A];if(ex)parent??=rt.records.get(ex.id)?.parent;
    if(hold&&ex&&!held&&ex.narrows.length){const n=ex.narrows[0];(rt.services.traffic??=new Map()).set(n.res,{actors:new Set([B]),entry:n.entry,dir:[-n.dir[0],-n.dir[1]]});held=true;}
    if(held&&ex&&rt.records.get(ex.id)?.status==='blocked'){const b=e.world.entities[B];b.pose.p=[b.pose.p[0]+(e.world.tick%2?0.002:-0.002),b.pose.p[1],b.pose.p[2]];}
    if(Math.hypot(a.pose.p[0]-anchor[0],a.pose.p[2]-anchor[2])>0.5){anchor=[...a.pose.p];headway=e.world.tick;}
  }
  return {events:events.filter(x=>x.id===id),held,parent,headway};
}

test('#2155 without wait-bound/3: a take whose approach walk is held waiting is still under way past 3,600 ticks',async()=>{
  const {e,id}=await take({}),{events,held,parent}=await run(e,id,3600,true);
  assert.ok(held,'the approach walk is held at its narrow way');
  assert.equal((e as any).rt.records.get(parent!)?.verb,'take_item','the held walk is the take\'s own approach');
  assert.equal(e.programOf(A),id,'still taking');assert.equal(events.some(x=>x.kind!=='step'),false,'never ended');
  assert.equal((e as any).rt.records.get(parent!)?.phase,'approach');
});

test('#2155 wait-bound/3: the same take ends route.blocked within a minute of the hold, naming the bound; nothing is left behind',async()=>{
  const {e,id}=await take({waitBoundV3:true}),{events,headway}=await run(e,id,2400,true);
  const failed=events.filter(x=>x.kind==='failed');assert.equal(failed.length,1,JSON.stringify(events.slice(-3)));
  assert.equal(failed[0].code,'route.blocked');assert.match(failed[0].message!,new RegExp(`wait-bound/3: the walk made no headway for a minute: traffic\\.yield \\(waiting for ${B}\\)`));
  assert.ok(failed[0].tick>=headway+1199&&failed[0].tick<=headway+1202,`ended at ${failed[0].tick}, last headway at ${headway}`);
  assert.equal(e.programOf(A),null);assert.equal(walkOf(e),undefined,'no walk left behind');
  assert.equal((e.world.entities['water-bowl'] as any).support.kind==='in-hand',false,'took nothing');
  assert.deepEqual(e.runtime.violations,[]);
});

test('#2155 wait-bound/3: an ordinary take still completes, and the bound is a state-hash input',async()=>{
  const {e,id}=await take({waitBoundV3:true}),{events}=await run(e,id,3000,false);
  assert.equal(events.at(-1)?.kind,'completed',JSON.stringify(events.at(-1)));
  assert.deepEqual((e.world.entities['water-bowl'] as any).support,{kind:'in-hand',by:A,hand:'left'});
  const off=await take({}),on=await take({waitBoundV3:true});
  assert.notEqual(on.e.stateHash(),off.e.stateHash(),'adopting wait-bound/3 changes the state hash');
  assert.deepEqual(e.runtime.violations,[]);
});
