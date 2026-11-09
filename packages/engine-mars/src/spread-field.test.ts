// #467 spread-field/1: Souls walking to a field one after another get spaced goals, and the bodies already standing there
// stay where they stood. Without the policy, the old centre-first order is kept (exact replay before the logged event).
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,EDEN_COMMONS_WORLD} from './engine.ts';

async function toTheField(policy:boolean,ids=['a','b','c','d']){
 const f=await marsFactory(EDEN_COMMONS_WORLD),e=f.create(f.genesis('spread-field')) as any;
 // the policy as a world adopts it: a logged runtime-policy event (spreadV2 is on for every edge world)
 e.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true,...(policy?{spreadFieldV1:true}:{})});
 // a 12 x 12 m green away from where bodies are born (the commons, [14,4]), so each walker has somewhere to go
 assert.deepEqual(e.installPlaceRegionsV1([{id:'green',label:'Green',polygon:[[-18,-18],[-6,-18],[-6,-6],[-18,-6]]}]),['green']);
 for(const id of ids)e.spawnHuman({id,label:id,soul:`s-${id}`});
 const goals:Record<string,[number,number]>={},moved:string[]=[],makeWay:string[]=[];
 for(const id of ids){
  const before=Object.fromEntries(Object.keys(goals).map(o=>[o,e.world.entities[o].pose.p.slice()]));
  const walk=e.perform({actor:id,label:'to the field',steps:[{verb:'walk_to',params:{to:'green',spread:'region/1',regionOutside:[]}}]});
  assert.equal(walk.ok,true,JSON.stringify(walk));
  let done=false;const startTick=e.world.tick;
  for(let i=0;i<3000&&!done;i++){const out=e.step();
   for(const r of e.rt.records.values() as Iterable<any>){const m=/^(.+):make-way:(\d+)$/.exec(String(r.id));if(m&&m[1] in goals&&Number(m[2])>=startTick&&!makeWay.includes(r.id))makeWay.push(r.id);}
   for(const p of out.programs as any[]){if(walk.ok&&p.id===walk.id&&(p.kind==='completed'||p.kind==='failed')){assert.equal(p.kind,'completed',JSON.stringify(p));done=true;}}
  }
  assert.equal(done,true,`${id}'s walk ended`);
  const p=e.world.entities[id].pose.p;goals[id]=[p[0],p[2]];
  for(const [o,q] of Object.entries(before)){const now=e.world.entities[o].pose.p;if(Math.hypot(now[0]-q[0],now[2]-q[2])>0.05)moved.push(`${o} moved while ${id} arrived`);}
 }
 return {goals,moved,makeWay};
}
const apart=(g:Record<string,[number,number]>)=>{let min=Infinity;const v=Object.values(g);for(let i=0;i<v.length;i++)for(let j=i+1;j<v.length;j++)min=Math.min(min,Math.hypot(v[i][0]-v[j][0],v[i][1]-v[j][1]));return min;};

test('#467 A1: four Souls returning to the field one after another stand at least 3 m apart, and nobody already there is moved',{timeout:300000},async()=>{
 const {goals,moved,makeWay}=await toTheField(true);
 assert.ok(apart(goals)>=2.99,`closest two goals ${apart(goals).toFixed(2)} m: ${JSON.stringify(goals)}`);
 assert.deepEqual(moved,[]);assert.deepEqual(makeWay,[],'no traffic.make-way record for a body that has arrived');
});
test('#467 A1/A3: eight arrivals: the old order displaces idle bodies, spread-field/1 displaces none',{timeout:300000},async()=>{
 // eight arrivals, one after another: without the policy later walkers move bodies already standing on the green (the bug);
 // with it, nobody who has arrived is moved
 const eight=['a','b','c','d','e','f','g','h'],off=await toTheField(false,eight),on=await toTheField(true,eight);
 assert.ok(off.moved.length>0&&off.makeWay.length>0,'the old order displaces idle bodies (so both checks can fail)');
 assert.deepEqual(on.moved,[]);assert.deepEqual(on.makeWay,[]);
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
test('#467 spread-field/1 is a state-hash input: a replay that misses its adoption diverges at once',async()=>{
 const f=await marsFactory(EDEN_COMMONS_WORLD),off=f.create(f.genesis('spread-field-hash')) as any,on=f.create(f.genesis('spread-field-hash')) as any;
 assert.equal(on.stateHash(),off.stateHash());
 on.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true,spreadFieldV1:true});off.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true});
 assert.notEqual(on.stateHash(),off.stateHash());
});
test('#467: a place under 8 m across keeps its centre-first order with the policy on',async()=>{
 const goals=async(policy:boolean)=>{const f=await marsFactory(EDEN_COMMONS_WORLD),e=f.create(f.genesis('spread-field-small')) as any;
  e.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true,...(policy?{spreadFieldV1:true}:{})});
  e.installPlaceRegionsV1([{id:'mat',label:'Mat',polygon:[[-14,-14],[-8,-14],[-8,-8],[-14,-8]]}]);
  const ids=['a','b','c'];for(const id of ids)e.spawnHuman({id,label:id,soul:`s-${id}`});
  const out:number[][]=[];for(const id of ids){const w=e.perform({actor:id,label:'mat',steps:[{verb:'walk_to',params:{to:'mat',spread:'region/1',regionOutside:[]}}]});
   for(let i=0;i<3000;i++){const s=e.step();if((s.programs as any[]).some(p=>p.id===w.id&&(p.kind==='completed'||p.kind==='failed')))break;}const p=e.world.entities[id].pose.p;out.push([p[0],p[2]]);}
  return out;};
 assert.deepEqual(await goals(true),await goals(false));
});

// A3 pinned: with the policy off, 16 walkers in turn to a 20 x 20 m green take exactly the goals main (0d48d8f4c) gives them,
// and the world ends in the same state hash (computed on main with this same script)
const MAIN_OFF={"goals": [[-14.4, -14.4], [-14.4, -13.4], [-13.39, -14.41], [-13.4, -13.4], [-16.4, -15.4], [-14.4, -13.4], [-13.38, -14.43], [-13.4, -13.4], [-13.4, -16.4], [-11.43, -15.37], [-16.4, -14.4], [-16.4, -12.4], [-15.4, -16.4], [-15.41, -13.39], [-15.42, -11.37], [-14.4, -16.4]], "hash": "3d717dead3f232b7a96bcbe78eac90b8e07a8134165bd5780c571b3eea917cb0", "tick": 9956};
test('#467 A3: policy off is main: the same 16 goals and the same state hash',{timeout:300000},async()=>{
 const f=await marsFactory(EDEN_COMMONS_WORLD),e=f.create(f.genesis('spread-field-pin')) as any;
 e.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true});
 e.installPlaceRegionsV1([{id:'green',label:'Green',polygon:[[-24,-24],[-4,-24],[-4,-4],[-24,-4]]}]);
 const ids=Array.from({length:16},(_,i)=>'w'+i);for(const id of ids)e.spawnHuman({id,label:id,soul:'s-'+id});
 const goals:number[][]=[];
 for(const id of ids){const w=e.perform({actor:id,label:'x',steps:[{verb:'walk_to',params:{to:'green',spread:'region/1',regionOutside:[]}}]});
  for(let i=0;i<3000;i++){const out=e.step();if((out.programs as any[]).some(p=>p.id===w.id&&(p.kind==='completed'||p.kind==='failed')))break;}
  const p=e.world.entities[id].pose.p;goals.push([Math.round(p[0]*100)/100,Math.round(p[2]*100)/100]);}
 assert.deepEqual(goals,MAIN_OFF.goals);assert.equal(e.world.tick,MAIN_OFF.tick);assert.equal(e.stateHash(),MAIN_OFF.hash);
});
// #1545 review: a crowded place and a place partly beyond walkable ground lose nothing to the policy
async function crowd(policy:boolean,n:number,polygon:number[][]){
 const f=await marsFactory(EDEN_COMMONS_WORLD),e=f.create(f.genesis('spread-field-crowd')) as any;
 e.configureRuntimePolicy({sleepBlockTicks:1200,spreadV2:true,routeReachV1:true,...(policy?{spreadFieldV1:true}:{})});
 e.installPlaceRegionsV1([{id:'plot',label:'Plot',polygon}]);
 const ids=Array.from({length:n},(_,i)=>'c'+i);for(const id of ids)e.spawnHuman({id,label:id,soul:'s-'+id});
 const tally:Record<string,number>={};
 for(const id of ids){const w=e.perform({actor:id,label:'plot',steps:[{verb:'walk_to',params:{to:'plot',spread:'region/1',regionOutside:[]}}]});
  if(!w.ok){const k='refused '+(w.diagnostic?.code??'');tally[k]=(tally[k]??0)+1;continue;}
  let kind='running';for(let i=0;i<4000&&kind==='running';i++){const out=e.step();for(const p of out.programs as any[])if(p.id===w.id&&(p.kind==='completed'||p.kind==='failed'))kind=p.kind==='failed'?'failed '+(p.diagnostic?.code??p.code??''):'completed';}
  tally[kind]=(tally[kind]??0)+1;}
 return tally;
}
test('#1545 review: a crowded 8 x 8 m place completes as many walks with the policy as without',{timeout:900000},async()=>{
 const sq=[[-29,-29],[-21,-29],[-21,-21],[-29,-21]],off=await crowd(false,40,sq),on=await crowd(true,40,sq);
 assert.ok((on.completed??0)>=(off.completed??0),`off ${JSON.stringify(off)}, on ${JSON.stringify(on)}`);
});
test('#1545 review: a place partly beyond the walkable ground keeps as many reachable arrivals with the policy',{timeout:900000},async()=>{
 const over=[[22,-6],[34,-6],[34,6],[22,6]],off=await crowd(false,30,over),on=await crowd(true,30,over);
 assert.ok((on.completed??0)>=(off.completed??0),`off ${JSON.stringify(off)}, on ${JSON.stringify(on)}`);
});
