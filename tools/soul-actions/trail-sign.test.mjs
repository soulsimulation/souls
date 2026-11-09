import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {writeFileSync,mkdirSync} from 'node:fs';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture,invite,accept,factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {coreLibrary,WorldModel} from '../../packages/world-compiler/src/index.ts';

import {createTrailSigns} from '../../apps/server/src/god/trail-sign.ts';
test('trail-sign site exposes finite supplies and an existing hand-operated output',()=>{
 const lib=coreLibrary(),block=lib.get('core-trail-sign-site@1'),bundle=lib.get('core-notice-board@2');
 assert.equal(block.state.stock.default,1);assert.equal(block.components.carryable,undefined);assert.ok(block.slots.some(s=>s.id==='out'&&s.kind==='surface'));assert.ok(bundle.tags.includes('hand-writable'));assert.equal(block.state.prepared.default,false);
});
test('native finite assembly work admits one real notice board only after completion, then writes and reads attributed guidance',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Assembling a trail sign'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/trail-sign-site@1',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3]}))}));await tick(50);
 const far=await here();assert.equal(bytes(far),bytes(absent));assert.ok(!/distant-/.test(JSON.stringify(far.here)));
 ok(god.act({ops:[{op:'place',def:'core/trail-sign-site@1',name:'block',p:[x+2,z]},
 {op:'place',def:'core/trail-sign-site@1',name:'private-block',p:[x-3,z],access:'private'},
 {op:'place',def:'core/trail-sign-site@1',name:'occupied-block',p:[x+8,z]},
 {op:'place',def:'core/notice-board@2',name:'obstruction',in:{parent:'occupied-block',slot:'out'},p:[0,0]},
 {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.5,z-.5]}]}));await tick(50);
 const ent=n=>[...god.model.entities.values()].find(e=>e.name===n),id=n=>ent(n).id,native=n=>f.host.engine.world.entities[id(n)];
 const bundles=()=>[...god.model.entities.values()].filter(e=>god.model.resolvedDef(e.def)?.name==='core-notice-board'&&e.name!=='obstruction');
 const act=(capability,params={})=>accept(f.host,edge.act(soul,{capability,params}));
 const finish=async r=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params)=>{const r=await finish(await act(cap,params));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 const cap='object:'+id('block')+':assemble-sign';assert.equal(edge.capabilities(soul).find(c=>c.id===cap)?.available,true);
 for(const [name,reason]of [['private-block',/private|access|owner/],['occupied-block',/occupied/]]){const denied=await act('object:'+id(name)+':assemble-sign');assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),reason);}
 await done('pick-up:'+id('bowl'));const hands=await act(cap);assert.equal(hands.accepted,false);assert.match(JSON.stringify(hands),/holding|hands/);await done('put-down:here');
 const cut=ok(await act(cap));assert.equal(ent('block').state.stock,1);assert.equal(bundles().length,0);
 for(let n=0;n<800&&body().human?.activity!=='garden';n++)await tick();assert.equal(body().human?.activity,'garden');await tick(100);assert.equal(ent('block').state.stock,1);assert.equal(bundles().length,0);
 await done('stand:here');await tick(20);assert.notEqual(edge.receipt(soul.soulId,cut.receipt.id).phase,'completed');assert.equal(ent('block').state.stock,1);assert.equal(bundles().length,0);
 const work=ok(await act(cap));let active=0;
 for(let n=0;n<1200&&edge.receipt(soul.soulId,work.receipt.id).phase!=='completed';n++){
  if(body().human?.activity==='garden'){active++;assert.equal(body().human.prop,'tool');assert.equal(ent('block').state.stock,1);assert.equal(bundles().length,0);}
  await tick();
 }
 const receipt=await finish(work);assert.equal(receipt.phase,'completed');assert.ok(active>=199,'native ten-second garden duration');await tick(20);
 assert.equal(ent('block').state.stock,0);assert.equal(ent('block').state.lastBy,'Ana');assert.equal(ent('block').state.lastReceipt,receipt.id);assert.equal(bundles().length,1);
 const bundle=bundles()[0],bid=bundle.id;assert.equal(bundle.in.parent,id('block'));assert.equal(bundle.in.slot,'out');
 assert.equal(ent('block').state.prepared,true);assert.equal(bundle.state.text,'');
 assert.equal(god.model.worldPose(bundle).y,0);assert.match(bundle.about?.what??'',/assembled by Ana.*supplied timber/);
 let commits=0;const repeated=createTrailSigns({model:god.model,engine:f.host.engine,levelAt:()=>0,soul:()=>({id:soul.soulId,entity_id:soul.entityId,name:soul.name}),denied:()=>null,commit(){commits++;return{accepted:true};},log(){}});repeated.onReceipt(receipt);assert.equal(commits,0);assert.equal(bundles().length,1);
 const exhausted=await act(cap);assert.equal(exhausted.accepted,false);assert.match(JSON.stringify(exhausted),/no supplied timber/);
 const inspect=await(await app.request('/v1/edge/inspect/'+id('block')+'?all=1')).json();assert.ok(JSON.stringify(inspect).includes('assemble-sign'));assert.ok(edge.capabilities(soul).some(c=>c.id==='read:'+id('block')&&c.label.includes('Ana')));
 const note='Creek trail: east.';const writing=ok(await act('object:'+bid+':write',{text:note}));assert.equal(bundle.state.text,'');const written=await finish(writing);assert.equal(written.phase,'completed',JSON.stringify(written));await tick(10);assert.equal(ent('sign').state.text,note);assert.equal(ent('sign').state.textBy,soul.soulId);const reading=await done('read:'+bid,{seconds:2});assert.match(reading.outcome.summary,/Creek trail: east/);assert.match(reading.outcome.summary,/written by Ana/);assert.equal(reading.outcome.untrusted,true);
 await done('object:'+bid+':erase');assert.equal(ent('sign').state.text,'');assert.equal(ent('sign').state.textBy,'');assert.match(ent('sign').about?.what??'',/assembled by Ana.*supplied timber/);await done('object:'+bid+':write',{text:note});assert.equal(ent('sign').state.text,note);assert.equal(ent('sign').state.textBy,soul.soulId);
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 for(const e of [ent('block'),bundles()[0]]){assert.deepEqual(restored.entities.get(e.id),JSON.parse(JSON.stringify(e)));assert.deepEqual(restored.worldPose(restored.entities.get(e.id)),god.model.worldPose(e));}
 assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100:bytes(far),nearby:bytes(await here())},activeGardenTicks:active,stock:ent('block').state,bundle:{id:bid,pose:god.model.worldPose(bundles()[0])},checks:['native approach and10second garden/tool','no admission or early consumption/board','ordinary interruption leaves supplies unchanged','private/full hands/occupied output refusals','atomic suppliedstock consumption and one actual notice board','duplicate receipt no additional board','actual native writing and attributed reading on created board; standard public-board erase and rewrite preserved','credited read and exhausted offer','exact snapshot identity/state/pose','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/trail-sign.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
