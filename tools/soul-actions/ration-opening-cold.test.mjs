import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fixture,invite,accept,factory} from '../../apps/server/test/native-owner-fixture.ts';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

test('supported-ground cold ration IDs preserve all nine state/action bindings and intended effects',{timeout:60000},async()=>{
 const results=[];
 for(const state of ['sealed','open','empty'])for(const action of ['open-ration','bite','eat']){
  const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let currentSoul;const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>currentSoul});
  const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
  const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}},ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
  try{
   await tick(5);await invite(f,'cold-worker');const row=await accept(f.host,f.souls.create('dev:cold-worker',{name:'Cold worker',description:'Cold literal supported ration test'})),soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};currentSoul=soul;await tick(5);
   const body=()=>f.host.engine.world.entities[soul.entityId];
   const walk=f.host.engine.perform({actor:soul.entityId,label:'Fixture ordinary supported ground walk',steps:[{verb:'walk_to',params:{to:[-20,0]}}]});assert.equal(walk.ok,true,JSON.stringify(walk));await tick(700);assert.ok(Math.abs(body().pose.p[0]+20)<1,'Fixture walk reaches its supported point');
   ok(god.act({ops:[{op:'place',def:'core/shop-counter@1',name:'cold-counter',p:[20,0]},{op:'place',def:'core/sealed-ration-tin@1',name:'cold-tin',in:{parent:'cold-counter',slot:'top'},p:[0,0],state:state==='sealed'?{}:{open:true,packed:false,left:state==='open'?1:0}}]}));await tick(20);
   const item=[...god.model.entities.values()].find(e=>e.name==='cold-tin'),parent=god.model.entities.get(item.in.parent),target=god.model.worldPose(item),start=body().pose.p.slice();assert.ok([start[0],start[2],target.x,target.z].every(n=>n>=-30&&n<=30));assert.ok(Math.hypot(start[0]-target.x,start[2]-target.z)>30);assert.equal(f.host.engine.world.entities[item.id].support.kind,'resting-on');assert.equal(f.host.engine.world.entities[item.id].support.on,parent.id);
   const before=structuredClone(item.state),requested='object:'+item.id+':'+action,result=edge.offerGate(soul,{capability:requested,params:{}})??await accept(f.host,edge.act(soul,{capability:requested,params:{}})),record={state,action,requested,result,before};results.push(record);
   const save=()=>{if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/supported-cold.private.json',JSON.stringify(results,null,2));}};save();
   assert.equal(result.receipt?.capability??result.capability,requested,JSON.stringify(record));if(result.resolved?.to!==undefined)assert.equal(result.resolved.to,requested,JSON.stringify(record));assert.notEqual(result.code,'capability.unknown',JSON.stringify(record));assert.notEqual(result.code,'place.ambiguous',JSON.stringify(record));
   const valid=state==='sealed'&&action==='open-ration'||state==='open'&&action!=='open-ration';assert.equal(result.accepted,valid,JSON.stringify(record));
   if(valid){let terminal,activeWorkTicks=0;for(let n=0;n<6000;n++){terminal=edge.receipt(soul.soulId,result.receipt.id);if(['completed','failed','replaced'].includes(terminal.phase))break;if(action==='open-ration'&&body().human?.activity==='operate'){activeWorkTicks++;assert.equal(god.model.entities.get(item.id).state.open,false,'No food access before native work completes');}await tick();}record.activeWorkTicks=activeWorkTicks;record.terminal=terminal;record.after=structuredClone(god.model.entities.get(item.id).state);save();assert.equal(terminal.capability,requested);assert.equal(terminal.phase,'completed',JSON.stringify(record));assert.ok(Math.hypot(body().pose.p[0]-start[0],body().pose.p[2]-start[2])>30,'Cold valid action walks normally');assert.equal(record.after.open,true);assert.equal(record.after.left,action==='open-ration'?1:action==='bite'?.5:0);if(action==='open-ration'){assert.ok(activeWorkTicks>=79,'Four seconds of actual native operate work');assert.ok(terminal.endedTick-terminal.startedTick>=80);assert.equal(record.after.packed,false);assert.equal(record.after.openedBy,'Cold worker');}}
   else{assert.ok(typeof result.reason==='string'&&result.reason.length>20,JSON.stringify(record));assert.deepEqual(god.model.entities.get(item.id).state,before);}
   assert.deepEqual(f.host.engine.runtime.violations,[]);
  }finally{comms.close();f.host.stop();f.db.close();}
 }
 console.log(JSON.stringify({status:'pass',cases:results.length,allNineColdExactIds:true,validWalkWorkEffects:true,ownUsefulInvalidStateRefusals:true,unknown:0,supportedGround:true}));
});
