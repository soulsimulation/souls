import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {fixture,invite,accept,factory} from '../../apps/server/test/native-owner-fixture.ts';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {coreLibrary,WorldModel} from '../../packages/world-compiler/src/index.ts';

test('tent mending is opt-in data and retains the existing flap and sleeping slots',()=>{
 const lib=coreLibrary(),old=lib.get('core-tent@2'),next=lib.get('core-tent@3'),awl=lib.get('core-sewing-awl@1');
 assert.ok(next&&awl);assert.equal(old.state.broken,undefined);
 assert.deepEqual(next.actions,old.actions);assert.deepEqual(next.slots,old.slots);
 assert.deepEqual(next.components.bed,old.components.bed);
 assert.equal(next.components.repairable.tool,'sewing-awl');assert.equal(awl.components.carryable.grips,1);
 const flap=next.make.args.shapes.filter(s=>s.role==='door'&&s.tint==='flap');
 assert.equal(flap.filter(s=>s.when==='@broken').length,4);assert.equal(flap.filter(s=>s.when==='!@broken').length,1);
});

test('native canvas mending: tool discovery, interruption, ownership and persistent completion',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false});
 let soul;const app=new Hono(),comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 await tick(5);await invite(f,'ana');
 const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Mending camping canvas'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 const place=ops=>{const r=god.act({ops});assert.equal(r.accepted,true,JSON.stringify(r));};
 place([{op:'place',def:'core/tent@3',name:'camp-tent',p:[x+3,z],state:{broken:true}},
 {op:'place',def:'core/tent@3',name:'private-tent',p:[x-3,z],state:{broken:true},access:'private'},
 {op:'place',def:'core/hammer@1',name:'wrong-tool',p:[x+.7,z+.5]}]);await tick(50);
 const id=n=>[...god.model.entities.values()].find(e=>e.name===n).id,cap=`object:${id('camp-tent')}:repair`;
 const act=c=>accept(f.host,edge.act(soul,{capability:c}));
 const finish=async r=>{assert.equal(r.accepted,true,JSON.stringify(r));for(let n=0;n<1600;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced','cancelled'].includes(end.phase))return end;await tick();}assert.fail('finite native action did not end');};
 const noTool=edge.capabilities(soul).find(c=>c.id===cap);assert.match(noTool?.label??'',/Mend the torn tent canvas/,'the repair offer describes the actual damage');assert.equal(noTool?.available,false);assert.equal(noTool.blocked.code,'repair.no-tool');
 const inspected=await (await app.request('/v1/edge/inspect/'+id('camp-tent'))).json();
 assert.ok(inspected.inspect.offers.some(o=>o.id===cap&&/Mend the torn tent canvas/.test(o.label)),'inspect exposes the damage-specific repair offer');
 for(const name of ['open','close']){
  const end=await finish(await act(`object:${id('camp-tent')}:${name}`));assert.equal(end.phase,'completed',JSON.stringify(end));await tick(5);
  assert.equal(god.model.get('camp-tent').state.open,name==='open');assert.equal(god.model.get('camp-tent').state.broken,true,'flap operation does not mend the tear');
 }
 const wrong=await act(cap);assert.equal(wrong.accepted,false);assert.match(JSON.stringify(wrong),/repair.no-tool/);assert.equal(god.model.get('camp-tent').state.broken,true);
 place([{op:'place',def:'core/sewing-awl@1',name:'awl',p:[x+.5,z-.5]}]);await tick(30);
 const offer=edge.capabilities(soul).find(c=>c.id===cap);assert.equal(offer?.available,true);assert.deepEqual(offer.params??{},{});
 const privateCap=`object:${id('private-tent')}:repair`,privateBefore=structuredClone(god.model.get('private-tent').state);
 const denied=await act(privateCap);assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),/object.private/);assert.deepEqual(god.model.get('private-tent').state,privateBefore);
 const interrupted=await act(cap);assert.equal(interrupted.accepted,true,JSON.stringify(interrupted));
 let working=false;
 for(let n=0;n<1200;n++){
  if(f.host.engine.rt.holder('actor:'+soul.entityId).map(i=>f.host.engine.rt.records.get(i)).some(r=>r?.verb==='repair_v1')){working=true;break;}
  await tick();
 }
 assert.ok(working,'real native repair starts after fetching the awl');assert.equal(god.model.get('camp-tent').state.broken,true);
 const stopped=await finish(await act('stand:here'));assert.equal(stopped.phase,'completed');
 assert.equal(edge.receipt(soul.soulId,interrupted.receipt.id).phase,'replaced');
 for(let n=0;n<100&&f.host.engine.rt.holder('actor:'+soul.entityId).some(i=>f.host.engine.rt.records.get(i)?.verb==='repair_v1');n++)await tick();
 assert.ok(!f.host.engine.rt.holder('actor:'+soul.entityId).some(i=>f.host.engine.rt.records.get(i)?.verb==='repair_v1'),'native hand withdrawal releases the repair reservation');
 assert.equal(god.model.get('camp-tent').state.broken,true,'interruption leaves the tear');
 assert.equal(f.host.engine.world.entities[id('awl')].support.by,soul.entityId,'tool stays in custody');
 const repaired=await finish(await act(cap));assert.equal(repaired.phase,'completed',JSON.stringify(repaired));await tick(5);
 const state=god.model.get('camp-tent').state;assert.equal(state.broken,false);assert.ok(state.repairedBy);
 assert.equal(f.host.engine.world.entities[id('awl')].support.by,soul.entityId);
 assert.equal(edge.capabilities(soul).some(c=>c.id===cap),false,'whole canvas has no repair offer');
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 assert.deepEqual(restored.get('camp-tent').state,state,'repair persists exactly');
 assert.equal(edge.capabilities(soul).find(c=>c.id===`lie:${id('camp-tent')}`),undefined,'the existing interior-mat admission limit remains unchanged');
 assert.deepEqual(god.model.get('private-tent').state,privateBefore);
 assert.deepEqual(f.host.engine.runtime.violations,[]);
});
