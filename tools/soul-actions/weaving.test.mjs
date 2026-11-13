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

import {createWeaving} from '../../apps/server/src/god/weaving.ts';
test('weaving block exposes finite stock and a separate carryable output',()=>{
 const lib=coreLibrary(),block=lib.get('core-table-loom@1'),bundle=lib.get('core-striped-cloth@1');
 assert.equal(block.state.stock.default,2);assert.equal(block.components.carryable,undefined);assert.ok(block.slots.some(s=>s.id==='out'&&s.kind==='surface'));assert.deepEqual(bundle.components.carryable,{mass:.12,grips:1});
});
test('native finite weaving work consumes stock and creates one supported persistent bundle only after completion',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Preparing weaving'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],x=18,z=0;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();for(const key of ['core-table-loom@1','core-striped-cloth@1','core-checked-cloth@1'])ok(god.act({ops:[{op:'define',def:coreLibrary().get(key)}]}));ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/table-loom@1',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3]}))}));await tick(50);
 const far=await here();assert.equal(bytes(far),bytes(absent));assert.ok(!/distant-/.test(JSON.stringify(far.here)));
 ok(god.act({ops:[{op:'place',def:'core/table-loom@1',name:'block',p:[x+2,z]},
 {op:'place',def:'core/table-loom@1',name:'private-block',p:[x-3,z],access:'private'},
 {op:'place',def:'core/table-loom@1',name:'occupied-block',p:[x+4,z]},
 {op:'place',def:'core/striped-cloth@1',name:'obstruction',in:{parent:'occupied-block',slot:'out'},p:[0,0]},
 {op:'place',def:'core/table@1',name:'display',p:[x+7,z]}, {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.5,z-.5]}]}));await tick(50);
 const ent=n=>[...god.model.entities.values()].find(e=>e.name===n||(n==='block'&&e.name==='fresh-loom')),id=n=>ent(n).id,native=n=>f.host.engine.world.entities[id(n)];
 const bundles=()=>[...god.model.entities.values()].filter(e=>god.model.resolvedDef(e.def)?.name==='core-striped-cloth'&&e.name!=='obstruction');
 const act=(capability,params={})=>accept(f.host,edge.act(soul,{capability,params}));
 const finish=async r=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params)=>{const r=await finish(await act(cap,params));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 let cap='object:'+id('block')+':weave-stripes';assert.equal(edge.capabilities(soul).find(c=>c.id===cap)?.available,true);
 for(const [name,reason]of [['private-block',/private|access|owner/],['occupied-block',/output surface/]]){const denied=await act('object:'+id(name)+':weave-stripes');assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),reason);}
 await done('pick-up:'+id('bowl'));const hands=await act(cap);assert.equal(hands.accepted,false);assert.match(JSON.stringify(hands),/holding|hands/);await done('put-down:here');
 const cut=ok(await act(cap));assert.equal(ent('block').state.stock,2);assert.equal(bundles().length,0);
 for(let n=0;n<800&&body().human?.activity!=='craft';n++)await tick();assert.equal(body().human?.activity,'craft');await tick(100);assert.equal(ent('block').state.stock,2);assert.equal(bundles().length,0);
 await done('stand:here');await tick(20);assert.notEqual(edge.receipt(soul.soulId,cut.receipt.id).phase,'completed');assert.equal(ent('block').state.stock,2);assert.equal(bundles().length,0);
 ok(god.act({ops:[{op:'place',def:'core/bench@1',name:'unrelated-bench',p:[-8,-8]}]}));
 const outbound=ok(await accept(f.host,edge.performBodies(soul,'fixture:ordinary-walk','Walk to the far start',[{verb:'mars:walk_to',params:{x:-20,z:0,level:0}}])));
 assert.equal((await finish(outbound)).phase,'completed');assert.ok(Math.hypot(body().pose.p[0]-20,body().pose.p[2])>30);
 const previous=id('block');ok(god.act({ops:[{op:'remove',id:previous},{op:'place',def:'core/table-loom@1',name:'fresh-loom',p:[20,0]},
 {op:'place',def:'core/table-loom@1',name:'fresh-blocked-loom',p:[20,4]},
 {op:'place',def:'core/striped-cloth@1',name:'obstruction',in:{parent:'fresh-blocked-loom',slot:'out'},p:[0,0]}]}));
 const fresh=id('fresh-loom');assert.notEqual(fresh,previous);cap='object:'+fresh+':weave-stripes';await tick(20);
 const checkedCap='object:'+id('fresh-blocked-loom')+':weave-checks';
 const checkedCold=await accept(f.host,app.request('/v1/edge/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability:checkedCap,strict:true})}).then(r=>r.json()));
 assert.equal(checkedCold.accepted,false);assert.match(JSON.stringify(checkedCold),/output surface/);assert.ok(!JSON.stringify(checkedCold).includes('capability.unknown'));assert.equal(ent('fresh-blocked-loom').state.stock,2);
 ok(god.act({ops:[{op:'move',id:id('unrelated-bench'),p:[-7,-8]}]}));const godEdit=god.store.undoable().seq;
 const work=ok(await accept(f.host,app.request('/v1/edge/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability:cap,strict:true})}).then(r=>r.json())));
 assert.equal(work.receipt.capability,cap);let active=0,walked=0;

 for(let n=0;n<1200&&edge.receipt(soul.soulId,work.receipt.id).phase!=='completed';n++){
  if((body().human?.speed??0)>.1)walked++;
  if(body().human?.activity==='craft'){active++;assert.equal(body().human.prop,'tool');assert.equal(ent('block').state.stock,2);assert.equal(bundles().length,0);}
  await tick();
 }
 const receipt=await finish(work);assert.equal(receipt.phase,'completed');assert.ok(active>=199,'native ten-second craft duration');await tick(20);
 assert.equal(ent('block').state.stock,1);assert.equal(ent('block').state.lastBy,'Ana');assert.equal(ent('block').state.lastReceipt,receipt.id);assert.equal(bundles().length,1);
 const bundle=bundles()[0],bid=bundle.id;assert.equal(bundle.in.parent,id('block'));assert.equal(bundle.in.slot,'out');
 assert.equal(f.host.engine.world.entities[bid].support.kind,'resting-on');assert.equal(f.host.engine.world.entities[bid].support.on,id('block'));
 assert.equal(god.model.worldPose(bundle).y,1);assert.ok(walked>0,'fresh exact far ID walked normally');assert.equal(god.store.undoable().seq,godEdit);
 const completedStock=structuredClone(ent('block').state),completedOutput=structuredClone(bundle);
 const undo=ok(god.undo());assert.equal(undo.reverted,godEdit);await tick(10);assert.equal(god.model.worldPose(ent('unrelated-bench')).x,-8);
 assert.deepEqual(ent('block').state,completedStock);assert.deepEqual(god.model.entities.get(bid),completedOutput);assert.equal(f.host.engine.world.entities[bid].support.on,id('block'));
 const redoEdit=god.store.redoable().seq;const redo=ok(god.redo());assert.equal(redo.reverted,redoEdit);await tick(10);assert.equal(god.model.worldPose(ent('unrelated-bench')).x,-7);
 assert.deepEqual(ent('block').state,completedStock);assert.deepEqual(god.model.entities.get(bid),completedOutput);

 let commits=0;const repeated=createWeaving({model:god.model,engine:f.host.engine,levelAt:()=>0,soul:()=>({id:soul.soulId,entity_id:soul.entityId,name:soul.name}),denied:()=>null,commit(){commits++;return{accepted:true};},log(){}});repeated.onReceipt(receipt);assert.equal(commits,0);assert.equal(bundles().length,1);
 const full=await act(cap);assert.equal(full.accepted,false);assert.match(JSON.stringify(full),/output surface/);
 const inspect=await(await app.request('/v1/edge/inspect/'+id('block')+'?all=1')).json();assert.ok(JSON.stringify(inspect).includes('weaving'));assert.ok(JSON.stringify(inspect).includes('read:'));
 await done('pick-up:'+bid);assert.equal(f.host.engine.world.entities[bid].support.kind,'in-hand');assert.equal(f.host.engine.world.entities[bid].support.by,soul.entityId);await done('put-on:'+id('display'));await tick(10);assert.equal(bundles()[0].id,bid);assert.equal(f.host.engine.world.entities[bid].support.kind,'resting-on');assert.equal(god.model.entities.get(bid).in.parent,id('display'));assert.equal(bundle.state.maker,'Ana');assert.equal(bundle.state.pattern,'striped');
 await done('object:'+id('block')+':weave-checks');const checked=[...god.model.entities.values()].find(e=>god.model.resolvedDef(e.def)?.name==='core-checked-cloth');assert.ok(checked);assert.equal(checked.state.maker,'Ana');assert.equal(checked.state.pattern,'checked');assert.equal(ent('block').state.stock,0);const empty=await act(cap);assert.equal(empty.accepted,false);assert.match(JSON.stringify(empty),/no supplied thread/);
 await tick(25);await here();const ix=await(await app.request('/v1/edge/inspect/'+checked.id)).json();assert.ok(JSON.stringify(ix).includes('Woven by Ana'));const read=await done('read:'+id('block'));assert.ok(JSON.stringify(read.outcome).includes('Ana'));assert.ok(JSON.stringify(read.outcome).includes('checked'));
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 for(const e of [ent('block'),bundles()[0],checked]){const current=god.model.entities.get(e.id);assert.deepEqual(restored.entities.get(e.id),JSON.parse(JSON.stringify(current)));assert.deepEqual(restored.worldPose(restored.entities.get(e.id)),god.model.worldPose(current));}
 assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100:bytes(far),nearby:bytes(await here())},activeCraftTicks:active,stock:ent('block').state,bundle:{pattern:bundle.state.pattern,maker:bundle.state.maker,pose:god.model.worldPose(bundles()[0])},checks:['native approach and10second craft/tool','no admission or early consumption/output','ordinary interruption leaves stock unchanged','private/full hands/occupied output refusals','atomic consumed stock and one actual native supported output','duplicate receipt no additional output','selected real output pickup/surface placement, second checked pattern','credited current inspection and exhausted offer','exact snapshot identity/custody/pose','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/weaving.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
