// #467 spread-field/1: Souls walking to a field one after another get spaced goals, and the bodies already standing there
// stay where they stood. Without the policy, the old centre-first order is kept (exact replay before the logged event).
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_COMMONS_WORLD} from './engine.ts';

async function fourToTheField(policy:boolean){
 const f=await marsFactory(EDEN_COMMONS_WORLD),e=f.create(f.genesis('spread-field')) as any;
 // the policy as a world adopts it: a logged runtime-policy event (spreadV2 is on for every edge world)
 e.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true,...(policy?{spreadFieldV1:true}:{})});
 // a 12 x 12 m green away from where bodies are born (the commons, [14,4]), so each walker has somewhere to go
 assert.deepEqual(e.installPlaceRegionsV1([{id:'green',label:'Green',polygon:[[-18,-18],[-6,-18],[-6,-6],[-18,-6]]}]),['green']);
 const ids=['a','b','c','d'];for(const id of ids)e.spawnHuman({id,label:id,soul:`s-${id}`});
 const goals:Record<string,[number,number]>={},moved:string[]=[],makeWay:string[]=[];
 for(const id of ids){
  const before=Object.fromEntries(Object.keys(goals).map(o=>[o,e.world.entities[o].pose.p.slice()]));
  const walk=e.perform({actor:id,label:'to the field',steps:[{verb:'walk_to',params:{to:'green',spread:'region/1',regionOutside:[]}}]});
  assert.equal(walk.ok,true,JSON.stringify(walk));
  let done=false;
  for(let i=0;i<3000&&!done;i++){const out=e.step();
   for(const p of out.programs as any[]){if(walk.ok&&p.id===walk.id&&(p.kind==='completed'||p.kind==='failed')){assert.equal(p.kind,'completed',JSON.stringify(p));done=true;}}
   for(const r of e.rt?.records?.values?.()??[]) if((r as any).params?.internalCause==='traffic.make-way'&&!makeWay.includes((r as any).id))makeWay.push((r as any).id);
  }
  assert.equal(done,true,`${id}'s walk ended`);
  const p=e.world.entities[id].pose.p;goals[id]=[p[0],p[2]];
  for(const [o,q] of Object.entries(before)){const now=e.world.entities[o].pose.p;if(Math.hypot(now[0]-q[0],now[2]-q[2])>0.05)moved.push(`${o} moved while ${id} arrived`);}
 }
 return {goals,moved,makeWay};
}
const apart=(g:Record<string,[number,number]>)=>{let min=Infinity;const v=Object.values(g);for(let i=0;i<v.length;i++)for(let j=i+1;j<v.length;j++)min=Math.min(min,Math.hypot(v[i][0]-v[j][0],v[i][1]-v[j][1]));return min;};

test('#467 A1: four Souls returning to the field one after another stand at least 3 m apart, and nobody already there is moved',{timeout:300000},async()=>{
 const {goals,moved,makeWay}=await fourToTheField(true);
 assert.ok(apart(goals)>=2.99,`closest two goals ${apart(goals).toFixed(2)} m: ${JSON.stringify(goals)}`);
 assert.deepEqual(moved,[]);assert.deepEqual(makeWay,[],'no body was made to make way');
});
test('#467 A3: without the policy the old centre-first order stands (what spread-field/1 changes)',{timeout:300000},async()=>{
 const off=await fourToTheField(false),on=await fourToTheField(true);
 assert.notDeepEqual(off.goals,on.goals,'the policy changes the order');
 assert.ok(apart(off.goals)<apart(on.goals),`off ${apart(off.goals).toFixed(2)} m, on ${apart(on.goals).toFixed(2)} m`);
});
test('#467: four Souls setting off together get goals at least 3 m apart (running walk targets count as taken)',{timeout:300000},async()=>{
 const f=await marsFactory(EDEN_COMMONS_WORLD),e=f.create(f.genesis('spread-field-together')) as any;
 e.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true,spreadFieldV1:true});
 e.installPlaceRegionsV1([{id:'green',label:'Green',polygon:[[-18,-18],[-6,-18],[-6,-6],[-18,-6]]}]);
 const ids=['a','b','c','d'];for(const id of ids)e.spawnHuman({id,label:id,soul:`s-${id}`});
 const walks=ids.map(id=>e.perform({actor:id,label:'to the green',steps:[{verb:'walk_to',params:{to:'green',spread:'region/1',regionOutside:[]}}]}));
 assert.ok(walks.every((w:any)=>w.ok),JSON.stringify(walks));
 const ended=new Map<string,string>();
 for(let i=0;i<4000&&ended.size<4;i++){const out=e.step();for(const p of out.programs as any[])for(const w of walks as any[])if(p.id===w.id&&(p.kind==='completed'||p.kind==='failed'))ended.set(w.id,p.kind);}
 assert.deepEqual([...ended.values()],['completed','completed','completed','completed']);
 const goals=Object.fromEntries(ids.map(id=>{const p=e.world.entities[id].pose.p;return [id,[p[0],p[2]] as [number,number]];}));
 assert.ok(apart(goals)>=2.99,`closest two ${apart(goals).toFixed(2)} m: ${JSON.stringify(goals)}`);
});
