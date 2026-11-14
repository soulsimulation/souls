// board-path/1: a Soul boarding the balloon past someone standing beside the basket. Before the rule its step to the next
// waypoint brushed the bystander (collision.human-human, which a live world answers by a recovery and the boarder's receipt
// ends engine.fault-recovered). With the rule it goes round the basket the other way, or waits with a named reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,GREEN_FIELD_WORLD,type MarsEngine} from './engine.ts';
import {rot2,type Vec2} from '../../../mars/viewer/engine/core/math.ts';

const AT:[number,number]=[10,-5],YAW=.3,BOARD_TIMEOUT=300;
async function world(rule:boolean){
  const f=await marsFactory({...GREEN_FIELD_WORLD,safeCrewRemoval:true}),e=f.create(f.genesis('board-path')) as MarsEngine;
  e.configureRuntimePolicy({sleepBlockTicks:1200,heldActivitiesV1:true,...(rule?{carrierBoardPathV1:true}:{})});
  assert.equal(e.installCarrierV1({id:'balloon',def:'hot-air-balloon',label:'Balloon',at:AT,yaw:YAW,route:'commons-hop',waitSeconds:600}),true);
  const E=()=>e.world.entities as Record<string,any>,y=E().balloon.pose.p[1];
  // test placement in the basket's own frame (door at local x −1.25, the boarder's way round at z ±1.2)
  const put=(id:string,l:Vec2)=>{const d=rot2(l,YAW);if(!E()[id])e.spawnHuman({id,label:id,soul:id});E()[id].pose.p=[AT[0]+d[0],y,AT[1]+d[1]];};
  return {e,E,put};
}
const board=(e:MarsEngine)=>e.perform({actor:'ana',label:'Ride',steps:[{verb:'mars:carrier_ride',params:{carrier:'balloon'}}]});
const brushes=(e:MarsEngine)=>e.runtime.violations.filter(v=>v.code==='collision.human-human');

test('board-path/1 A2: without the rule the boarder brushes a Soul idle beside the basket',async()=>{
  const {e,E,put}=await world(false);put('ana',[.6,1.7]);put('cy',[-.4,1.45]);
  assert.ok(board(e).ok);
  for(let i=0;i<600&&!brushes(e).length&&E().ana.human.carrier?.phase!=='seated';i++)e.step();
  assert.ok(brushes(e).length>0,'the old step brushes cy');
});

test('board-path/1 A1/A2: the boarder goes round the basket the other way and boards, with no fault',async()=>{
  const {e,E,put}=await world(true);put('ana',[.6,1.7]);put('cy',[-.4,1.45]);
  const cy=[...E().cy.pose.p];
  assert.ok(board(e).ok);
  for(let i=0;i<1200&&E().ana.human.carrier?.phase!=='seated';i++)e.step();
  assert.equal(E().ana.human.carrier?.phase,'seated');
  assert.deepEqual(e.runtime.violations,[]);assert.deepEqual(E().cy.pose.p,cy,'cy was never moved');
});

test('board-path/1 A1: blocked both ways it waits (named, not still), then boards once the way clears',async()=>{
  const {e,E,put}=await world(true);put('ana',[.6,1.7]);put('cy',[-.4,1.45]);put('bo',[-.4,-1.45]);
  const marks:any[]=[];(e as any).rt.observers.push({onEvent:(_:unknown,ev:any)=>{if(ev.name==='carrier.board-path-blocked')marks.push(ev.data);}});
  const at0=[...E().ana.pose.p];
  assert.ok(board(e).ok);
  for(let i=0;i<100;i++){e.step();assert.equal(e.stillnessV1().still,false,'never still while held');}
  assert.deepEqual(E().ana.pose.p,at0,'waits where it stands');assert.equal(E().ana.human.carrier?.phase,'boarding');
  assert.equal(marks.length,1);assert.equal(marks[0].by,'cy');
  {const d=rot2([-.4,-5],YAW);assert.ok(e.perform({actor:'bo',label:'Step away',steps:[{verb:'walk_to',params:{to:[AT[0]+d[0],AT[1]+d[1]],standoff:0}}]}).ok);}   // bo walks away
  for(let i=0;i<1200&&E().ana.human.carrier?.phase!=='seated';i++)e.step();
  assert.equal(E().ana.human.carrier?.phase,'seated');assert.deepEqual(e.runtime.violations,[]);
});

test('board-path/1 A1: a wait is bounded; the seat is given up with carrier.board-path-blocked, no fault',async()=>{
  const {e,E,put}=await world(true);put('ana',[.6,1.7]);put('cy',[-.4,1.45]);put('bo',[-.4,-1.45]);
  const r=board(e);assert.ok(r.ok);
  for(let i=0;i<BOARD_TIMEOUT+20;i++)e.step();
  assert.equal(E().ana.human.carrier,undefined,'out of the ride');assert.equal(E().balloon.carrier.seats['rider-b']??E().balloon.carrier.seats['rider-a'],null);
  const fail=(e as any).rt.events.find((ev:any)=>ev.type==='failed'&&ev.diagnostic?.code==='carrier.board-path-blocked')??[...(e as any).rt.records.values()].find((rec:any)=>rec.verb==='carrier_ride');
  assert.equal(fail?.diagnostic?.code??fail?.error?.code??fail?.status,'carrier.board-path-blocked',JSON.stringify(fail));
  assert.deepEqual(e.runtime.violations,[]);
});
