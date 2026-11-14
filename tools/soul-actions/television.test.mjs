import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {WorldModel} from '../../packages/world-compiler/src/model.ts';

// #2281: a Soul turns a television on and changes its picture through offered acts; the state is a world edit others see.
test('television: switch on, change channel, switch off, by offered ids; refused while off; persisted', {timeout:180000}, async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false});const app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 const tick=async(n=5)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 await tick();await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'TV test'}));soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick();
 const body=()=>f.host.engine.world.entities[soul.entityId],[ax,az]=[body().pose.p[0],body().pose.p[2]];
 assert.equal(god.act({ops:[{op:'place',def:'core/television@2',name:'tv',p:[ax+0.3,az-1.8],r:0}]}).accepted,true);await tick(45);
 const id=god.model.get('tv').id,state=()=>god.model.get('tv').state??{};
 const here=async()=>{const r=await app.request('/v1/edge/here?include=doHere');assert.equal(r.status,200);return (await r.json()).here.objects.find(o=>o.id===id);};
 const offered=()=>edge.capabilities(soul).filter(c=>c.object===id).map(c=>c.id).sort();
 const ids=['change-channel','switch-off','switch-on'].map(a=>`object:${id}:${a}`);
 assert.deepEqual(offered(),ids,'the television offers its three acts by id');
 const act=async(cap,accepted=true)=>{const r=await accept(f.host,app.request('/v1/edge/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability:cap})}));const b=await r.json();assert.equal(b.accepted,accepted,JSON.stringify(b));return b;};
 const done=async r=>{for(let n=0;n<900;n++){const ph=edge.receipt(soul.soulId,r.receipt.id)?.phase;if(['completed','failed','cancelled','replaced'].includes(ph))return ph;await tick(1);}return 'timeout';};
 await act(`object:${id}:change-channel`,false);
 assert.equal(await done(await act(`object:${id}:switch-on`)),'completed');assert.equal(state().on,true);
 assert.deepEqual((await here())?.state,{on:true,channel:'garden'},'nearby Souls see it on, showing the garden');
 const seen=[];for(let i=0;i<4;i++){assert.equal(await done(await act(`object:${id}:change-channel`)),'completed');seen.push(state().channel);}
 assert.deepEqual(seen,['sea','stars','test-card','garden'],'the channel cycles through the fixed set');
 assert.equal(await done(await act(`object:${id}:change-channel`)),'completed');

 assert.deepEqual((await here())?.state,{on:true,channel:'sea'},'nearby Souls see the picture it shows');
 assert.equal(await done(await act(`object:${id}:switch-off`)),'completed');assert.equal(state().on,false);
 await act(`object:${id}:change-channel`,false);
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 assert.deepEqual([restored.get('tv').state.on,restored.get('tv').state.channel],[false,'sea'],'the state is world state: it persists');
 assert.deepEqual(f.host.engine.runtime.violations,[]);
});
