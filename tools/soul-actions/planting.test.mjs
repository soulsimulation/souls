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

import {createPlanting} from '../../apps/server/src/god/planting.ts';
import {dryingOps} from '../../apps/server/src/god/garden.ts';
import {HOOK_PEG,CAN_GRIP} from '../../packages/world-compiler/src/core-kit/watering-can.ts';
test('opt-in planting revision keeps prior bed and supplies a finite tray',()=>{
 const lib=coreLibrary(),old=lib.get('core-garden-planter@2'),bed=lib.get('core-garden-planter@3');assert.equal(old.state.planted,undefined);assert.equal(bed.state.planted.default,false);assert.equal(bed.state.stock.default,1);assert.equal(bed.components.carryable,undefined);assert.ok(bed.actions.some(a=>a.name==='plant-seedlings'));
});
test('native planting consumes finite tray only after work, then same bed is watered and grows',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Preparing seedling'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],x=18,z=0;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/garden-planter@3',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3]}))}));await tick(50);
 const far=await here();assert.equal(bytes(far),bytes(absent));assert.ok(!/distant-/.test(JSON.stringify(far.here)));
 ok(god.act({ops:[{op:'place',def:'core/garden-planter@3',name:'block',p:[x+2,z]},
 {op:'place',def:'core/garden-planter@3',name:'private-block',p:[x-3,z],access:'private'},
 {op:'place',def:'core/can-hook@1',name:'hook',p:[x-2,z-1]},
 {op:'place',def:'core/watering-can@3',name:'can',in:{parent:'hook',slot:'peg'},p:[HOOK_PEG[0]-CAN_GRIP[0],HOOK_PEG[1]-CAN_GRIP[1],HOOK_PEG[2]-CAN_GRIP[2]],r:Math.PI/2,state:{level:1}},
 {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.5,z-.5]}]}));await tick(50);
 const ent=n=>[...god.model.entities.values()].find(e=>e.name===n||(n==='block'&&e.name==='fresh-bed')),id=n=>ent(n).id,native=n=>f.host.engine.world.entities[id(n)];
 const act=(capability,params={})=>accept(f.host,edge.act(soul,{capability,params}));
 const finish=async r=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params)=>{const r=await finish(await act(cap,params));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 let cap='object:'+id('block')+':plant-seedlings';assert.equal(edge.capabilities(soul).find(c=>c.id===cap)?.available,true);
 for(const [name,reason]of [['private-block',/private|access|owner/]]){const denied=await act('object:'+id(name)+':plant-seedlings');assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),reason);}
 await done('pick-up:'+id('bowl'));const hands=await act(cap);assert.equal(hands.accepted,false);assert.match(JSON.stringify(hands),/holding|hands/);await done('put-down:here');
 const cut=ok(await act(cap));assert.equal(ent('block').state.stock,1);assert.equal(ent('block').state.planted,false);
 for(let n=0;n<800&&body().human?.activity!=='craft';n++)await tick();assert.equal(body().human?.activity,'craft');await tick(100);assert.equal(ent('block').state.stock,1);assert.equal(ent('block').state.planted,false);
 await done('stand:here');await tick(20);assert.notEqual(edge.receipt(soul.soulId,cut.receipt.id).phase,'completed');assert.equal(ent('block').state.stock,1);assert.equal(ent('block').state.planted,false);
 ok(god.act({ops:[{op:'place',def:'core/bench@1',name:'unrelated-bench',p:[-8,-8]}]}));
 const outbound=ok(await accept(f.host,edge.performBodies(soul,'fixture:ordinary-walk','Walk to the far start',[{verb:'mars:walk_to',params:{x:-20,z:0,level:0}}])));
 assert.equal((await finish(outbound)).phase,'completed');assert.ok(Math.hypot(body().pose.p[0]-20,body().pose.p[2])>30);
 const previous=id('block');ok(god.act({ops:[{op:'remove',id:previous},{op:'place',def:'core/garden-planter@3',name:'fresh-bed',p:[20,0]}]}));
 const fresh=id('fresh-bed');assert.notEqual(fresh,previous);cap='object:'+fresh+':plant-seedlings';await tick(20);
 ok(god.act({ops:[{op:'move',id:id('unrelated-bench'),p:[-7,-8]}]}));const godEdit=god.store.undoable().seq;
 const work=ok(await accept(f.host,app.request('/v1/edge/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability:cap,strict:true})}).then(r=>r.json())));
 assert.equal(work.receipt.capability,cap);let active=0,walked=0;

 for(let n=0;n<1200&&edge.receipt(soul.soulId,work.receipt.id).phase!=='completed';n++){
  if((body().human?.speed??0)>.1)walked++;
  if(body().human?.activity==='craft'){active++;assert.equal(body().human.prop,'tool');assert.equal(ent('block').state.stock,1);assert.equal(ent('block').state.planted,false);}
  await tick();
 }
 const receipt=await finish(work);assert.equal(receipt.phase,'completed');assert.ok(active>=199,'native ten-second craft duration');await tick(20);
 assert.equal(ent('block').state.stock,0);assert.equal(ent('block').state.planted,true);assert.equal(ent('block').state.growth,1);assert.equal(ent('block').state.lastBy,'Ana');assert.equal(ent('block').state.lastReceipt,receipt.id);
 assert.ok(walked>0,'fresh exact far ID walked normally');assert.equal(god.store.undoable().seq,godEdit);
 const planted=structuredClone(ent('block'));
 const undo=ok(god.undo());assert.equal(undo.reverted,godEdit);await tick(10);
 assert.equal(god.model.worldPose(ent('unrelated-bench')).x,-8);assert.deepEqual(ent('block'),planted);
 const redoEdit=god.store.redoable().seq;const redo=ok(god.redo());assert.equal(redo.reverted,redoEdit);await tick(10);
 assert.equal(god.model.worldPose(ent('unrelated-bench')).x,-7);assert.deepEqual(ent('block'),planted);

 let commits=0;const repeated=createPlanting({model:god.model,engine:f.host.engine,levelAt:()=>0,soul:()=>({id:soul.soulId,entity_id:soul.entityId,name:soul.name}),denied:()=>null,commit(){commits++;return{accepted:true};},log(){}});repeated.onReceipt(receipt);assert.equal(commits,0);
 const exhausted=await act(cap);assert.equal(exhausted.accepted,false);assert.match(JSON.stringify(exhausted),/no supplied seedlings/);
 const inspect=await(await app.request('/v1/edge/inspect/'+id('block')+'?all=1')).json();assert.ok(JSON.stringify(inspect).includes('plant'));assert.ok(edge.capabilities(soul).some(c=>c.id==='read:'+id('block')&&c.label.includes('Ana')),'existing read offer exposes planted credit');
 await done('object:'+id('block')+':water');await tick(10);assert.equal(ent('block').state.moisture,1);assert.ok(ent('can').state.level<1);assert.equal(ent('can').in.parent,id('hook'));assert.equal(ent('block').state.growth,1);
 const next=dryingOps(god.model,1);assert.ok(next.some(op=>op.id===id('block')&&op.state.growth===2));ok(god.act({ops:next}));await tick(10);assert.equal(ent('block').state.growth,2);
 assert.equal(ent('private-block').state.growth,0,'unsown bed does not grow during daily pass');
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 for(const e of [ent('block'),ent('can')])assert.deepEqual(restored.entities.get(e.id),JSON.parse(JSON.stringify(e)));
 assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100:bytes(far),nearby:bytes(await here())},activeCraftTicks:active,plantedState:ent('block').state,checks:['actual native ten-second planting','no early effects/interruption preserves stock','private/full hands refusals','atomic finite stock/credit/planting','duplicate completion unchanged','actual existing can watering and hang-back','daily growth only after planting','current facts and exact snapshot','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/planting.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
