import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {fixture,invite,accept,factory} from '../../apps/server/test/native-owner-fixture.ts';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

test('same held coffee mug retains useful actions across ordinary native restart',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'held-coffee-restart-'));let soul,id,before;
 try{for(let boot=0;boot<2;boot++){
  const f=fixture(join(dir,'world.db'),factory,{durableClockV1:true});f.brain.quiesce();
  const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false});
  const app=new Hono();const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
  const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
  const bridge=installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
  const tick=async(n=5)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
  const act=async(capability)=>{const input={capability};const r=await accept(f.host,Promise.resolve(edge.offerGate(soul,input)??edge.act(soul,input)));assert.equal(r.accepted,true,JSON.stringify(r));assert.equal(r.receipt.capability,capability);for(let i=0;i<3000;i++){const receipt=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','cancelled'].includes(receipt.phase)){assert.equal(receipt.phase,'completed',JSON.stringify(receipt));return receipt;}await tick(1);}assert.fail('native receipt timed out');};
  try{await tick();
   if(!boot){await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Retain the same held coffee mug across restart.'}));soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(10);
    const b=f.host.engine.world.entities[soul.entityId],x=b.pose.p[0],z=b.pose.p[2]-1.4;
    const r=god.act({ops:[{op:'place',def:'core/counter@1',name:'coffee-counter',p:[x,z]},{op:'place',def:'core/kettle@2',name:'coffee-kettle',in:{parent:'coffee-counter',slot:'top'},p:[.3,.1],state:{level:1,heatTick:f.host.engine.world.tick}},{op:'place',def:'core/coffee-mug@1',name:'coffee-mug',in:{parent:'coffee-counter',slot:'top'},p:[-.42,.19],owner:'soul:'+soul.soulId,access:'private'}]});assert.equal(r.accepted,true,JSON.stringify(r));await tick(40);
    id=[...god.model.entities.values()].find(e=>e.name==='coffee-mug').id;
    await act('object:'+id+':brew');await act('object:'+id+':sip');await tick(20);
    before=structuredClone({id,state:god.model.entities.get(id).state,support:f.host.engine.world.entities[id].support,owner:god.model.entities.get(id).owner,access:god.model.entities.get(id).access});
    assert.equal(before.support.kind,'in-hand');assert.equal(before.support.by,soul.entityId);assert.ok(Object.values(f.host.engine.world.entities[soul.entityId].human.heldItemsV1??{}).includes(id));assert.ok(before.state.tea>0&&before.state.tea<1);
   }else{
    assert.equal(f.host.engine.world.entities[id].support.kind,'in-hand');assert.equal(f.host.engine.world.entities[id].support.by,soul.entityId);assert.ok(Object.values(f.host.engine.world.entities[soul.entityId].human.heldItemsV1??{}).includes(id));assert.deepEqual(god.model.entities.get(id).state,before.state);assert.equal(god.model.entities.get(id).owner,before.owner);assert.equal(god.model.entities.get(id).access,before.access);
    bridge.perceive.sync(true);const caps=edge.capabilities(soul);const sip=caps.find(c=>c.id==='object:'+id+':sip');assert.ok(sip,JSON.stringify(caps.map(c=>c.id)));assert.equal(sip.available,true,JSON.stringify(sip));const brew=caps.find(c=>c.id==='object:'+id+':brew');assert.equal(brew.available,false);assert.equal(brew.blocked.code,'tea.cup-full');assert.match(brew.blocked.reason,/coffee/);
    const old=god.model.entities.get(id).state.tea;await act('object:'+id+':sip');assert.ok(god.model.entities.get(id).state.tea<old);assert.equal(f.host.engine.world.entities[id].support.by,soul.entityId);
    const put=caps.find(c=>c.id.startsWith('put-on:')&&c.label.includes('coffee-counter'));assert.ok(put,JSON.stringify(caps.map(c=>({id:c.id,label:c.label}))));await act(put.id);assert.equal(f.host.engine.world.entities[id].support.kind,'resting-on');assert.equal(god.model.entities.get(id).in.parent,[...god.model.entities.values()].find(e=>e.name==='coffee-counter').id);
    const returned=god.model.entities.get(id).state.tea;await act('object:'+id+':sip');assert.ok(god.model.entities.get(id).state.tea<returned,'supported sip still works after return');assert.equal(f.host.engine.world.entities[id].support.by,soul.entityId);assert.deepEqual(f.host.engine.runtime.violations,[]);
   }
  }finally{comms.close();f.host.stop();f.db.close();}
 }}finally{rmSync(dir,{recursive:true,force:true});}
});
