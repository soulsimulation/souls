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

import {GodPerceive} from '../../apps/server/src/god/perceive.ts';

test('non-tea declared-action carryable retains its own refusal and custody across native restart',{timeout:60000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'held-action-tool-'));let soul,other,id,before;
 try{for(let boot=0;boot<2;boot++){
  const f=fixture(join(dir,'world.db'),factory,{durableClockV1:true});f.brain.quiesce();
  const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();
  const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
  const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
  const bridge=installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
  const tick=async(n=5)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
  const done=async(capability)=>{const input={capability};const r=await accept(f.host,Promise.resolve(edge.offerGate(soul,input)??edge.act(soul,input)));assert.equal(r.accepted,true,JSON.stringify(r));assert.equal(r.receipt.capability,capability);for(let i=0;i<3000;i++){const q=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','cancelled'].includes(q.phase)){assert.equal(q.phase,'completed',JSON.stringify(q));return;}await tick(1);}assert.fail('native receipt timeout');};
  try{await tick();
   if(!boot){
    await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Keep the same action-bearing harvest basket.'}));soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(10);
    const b=f.host.engine.world.entities[soul.entityId],x=b.pose.p[0],z=b.pose.p[2]-1.4;
    const placed=god.act({ops:[{op:'place',def:'core/counter@1',name:'tool-counter',p:[x,z]},{op:'place',def:'core/harvest-basket@1',name:'harvest-basket',in:{parent:'tool-counter',slot:'top'},p:[0,.1],state:{fruit:2},owner:'soul:'+soul.soulId,access:'private'}]});assert.equal(placed.accepted,true,JSON.stringify(placed));await tick(40);
    id=[...god.model.entities.values()].find(e=>e.name==='harvest-basket').id;await done('pick-up:'+id);await tick(20);
    const e=god.model.entities.get(id),native=f.host.engine.world.entities[id];before=structuredClone({id,state:e.state,owner:e.owner,access:e.access,support:native.support});assert.equal(native.support.kind,'in-hand');assert.equal(native.support.by,soul.entityId);
    await invite(f,'ben');const ben=await accept(f.host,f.souls.create('dev:ben',{name:'Ben',description:'Does not own the private basket.'}));other={soulId:ben.id,entityId:ben.entity_id,name:ben.name,owner:ben.owner};await tick(10);
   }else{
    const e=god.model.entities.get(id),native=f.host.engine.world.entities[id];assert.deepEqual({id:e.id,state:e.state,owner:e.owner,access:e.access,support:native.support},before);assert.ok(Object.values(f.host.engine.world.entities[soul.entityId].human.heldItemsV1??{}).includes(id));
    bridge.perceive.sync(true);const capability='object:'+id+':harvest',cap=edge.capabilities(soul).find(c=>c.id===capability);assert.ok(cap);assert.equal(cap.available,false);assert.equal(cap.blocked.code,'harvest.no-planter',JSON.stringify(cap));assert.match(cap.blocked.reason,/planter/);
    const input={capability};const refusal=await accept(f.host,Promise.resolve(edge.offerGate(soul,input)??edge.act(soul,input)));assert.equal(refusal.accepted,false);assert.equal(refusal.code,'harvest.no-planter');assert.equal(god.model.entities.get(id).state.fruit,2);assert.equal(f.host.engine.world.entities[id].support.by,soul.entityId);
    const denied=edge.capabilities(other).find(c=>c.id===capability);assert.ok(denied);assert.equal(denied.available,false);assert.equal(denied.blocked.code,'object.private');
    // Isolated projection controls use copies, never mutate the live native world or model.
    const project=(item= e,patch={})=>{const entities={...f.host.engine.world.entities,...patch};return new GodPerceive({...bridge.perceive.h,engine:{world:{...f.host.engine.world,entities}},engineOwned:()=>true}).wantOne(item,false);};
    assert.ok(bridge.perceive.wantOne(e,false),'real held carryable with declared actions is projected');
    assert.equal(project(e,{[id]:{...native,support:{kind:'ground'}}}),null,'non-held body descendants stay excluded');
    assert.equal(project(e,{[id]:{...native,support:{kind:'in-hand',by:other.entityId,hand:'right'}}}),null,'native holder must match model parent');
    assert.equal(project(e,{[soul.entityId]:{...f.host.engine.world.entities[soul.entityId],human:undefined}}),null,'holder must be a real human');
    assert.equal(project({...e,def:'core-hammer@1'}),null,'actionless carryable stays excluded');
    assert.equal(project({...e,def:'core-candle-stand@1'}),null,'non-carryable declared-action descendants stay excluded');
    assert.equal(project(god.model.entities.get(soul.entityId)),null,'body itself stays excluded');
    const put=edge.capabilities(soul).find(c=>c.id.startsWith('put-on:')&&c.label.includes('tool-counter'));assert.ok(put);await done(put.id);assert.equal(f.host.engine.world.entities[id].support.kind,'resting-on');assert.equal(god.model.entities.get(id).state.fruit,2);assert.deepEqual(f.host.engine.runtime.violations,[]);
   }
  }finally{comms.close();f.host.stop();f.db.close();}
 }}finally{rmSync(dir,{recursive:true,force:true});}
});
