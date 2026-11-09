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

test('native wax portions persist through chosen mixing and one real portable molded artifact',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Blending wax'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();for(const key of ['core-wax-bench@1','core-wax-medallion@1'])ok(god.act({ops:[{op:'define',def:coreLibrary().get(key)}]}));ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/wax-bench@1',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3]}))}));await tick(50);
 const far=await here();assert.equal(bytes(far),bytes(absent));assert.ok(!/distant-/.test(JSON.stringify(far.here)));
 ok(god.act({ops:[{op:'place',def:'core/wax-bench@1',name:'block',p:[x+2,z]},
 {op:'place',def:'core/wax-bench@1',name:'private-block',p:[x-3,z],access:'private'},
 {op:'place',def:'core/wax-bench@1',name:'occupied-block',p:[x+4,z]},
 {op:'place',def:'core/wax-medallion@1',name:'obstruction',in:{parent:'occupied-block',slot:'out'},p:[0,0]},
 {op:'place',def:'core/table@1',name:'display',p:[x+7,z]}, {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.5,z-.5]}]}));await tick(50);
 const ent=n=>[...god.model.entities.values()].find(e=>e.name===n),id=n=>ent(n).id,native=n=>f.host.engine.world.entities[id(n)];
 const sculptures=()=>[...god.model.entities.values()].filter(e=>god.model.resolvedDef(e.def)?.name==='core-wax-medallion'&&e.name!=='obstruction');
 const act=(capability,params={})=>accept(f.host,edge.act(soul,{capability,params}));
 const finish=async r=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params)=>{const r=await finish(await act(cap,params));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 const cap=a=>'object:'+id('block')+':'+a;
 for(const[name,why]of[['private-block',/private|access/],['occupied-block',/output/]]){
  if(name==='occupied-block')ok(god.act({ops:[{op:'set',id:id(name),state:{units:1,red:1}}]}));
  const r=await act('object:'+id(name)+':'+(name==='private-block'?'mix-red':'mold'));assert.equal(r.accepted,false);assert.match(JSON.stringify(r),why);
 }
 const empty=await act(cap('mold'));assert.equal(empty.accepted,false);
 await done('pick-up:'+id('bowl'));const held=await act(cap('mix-red'));assert.equal(held.accepted,false);assert.match(JSON.stringify(held),/holding/);await done('put-down:here');
 const cut=ok(await act(cap('mix-red')));for(let i=0;i<800&&body().human?.activity!=='craft';i++)await tick();assert.equal(body().human?.activity,'craft');await tick(100);assert.equal(ent('block').state.redStock,3);await done('stand:here');await tick(20);assert.notEqual(edge.receipt(soul.soulId,cut.receipt.id).phase,'completed');assert.equal(ent('block').state.units,0);
 let active=0;const first=ok(await act(cap('mix-red')));for(let i=0;i<1400&&edge.receipt(soul.soulId,first.receipt.id).phase!=='completed';i++){if(body().human?.activity==='craft'){active++;assert.equal(ent('block').state.units,0);}await tick();}assert.equal((await finish(first)).phase,'completed');assert.ok(active>=199);assert.equal(ent('block').state.red,1);assert.equal(ent('block').state.redStock,2);assert.equal(ent('block').params.blend,'#dc3741');
 await done(cap('mix-blue'));assert.equal(ent('block').state.blue,1);assert.equal(ent('block').params.blend,'#874b8a');
 await done(cap('mix-red'));assert.equal(ent('block').state.red,2);assert.equal(ent('block').state.units,3);assert.equal(ent('block').params.blend,'#a34471');
 const finished=await done(cap('mold'));await tick(10);const output=sculptures()[0];assert.ok(output);assert.equal(output.state.recipe,'2 red, 0 yellow, 1 blue');assert.equal(output.state.maker,'Ana');assert.equal(output.params.wax,'#a34471');assert.equal(ent('block').state.units,0);assert.equal(native('block').id,id('block'));assert.equal(f.host.engine.world.entities[output.id].support.kind,'resting-on');
 await done('pick-up:'+output.id);await done('put-on:'+id('display'));assert.equal(god.model.entities.get(output.id).in.parent,id('display'));assert.equal(f.host.engine.world.entities[output.id].support.kind,'resting-on');
 const read=await done('read:'+id('block'));assert.match(JSON.stringify(read),/2 red, 0 yellow, 1 blue/);
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);assert.deepEqual(restored.entities.get(output.id),JSON.parse(JSON.stringify(god.model.entities.get(output.id))));assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100:bytes(far)},activeCraftTicks:active,recipe:output.state.recipe,color:output.params.wax,maker:output.state.maker,stock:ent('block').state,checks:['public define both defs','100 distant local benches zero bytes','access and empty/full output refusals','native10s completed-only finite selected material consumption','precompletion cancellation preserves mixture/stock','different chosen proportions change actual color','mold exact recipe/maker and native supported portable entity','pickup and surface placement','read result and snapshot persistence','zero native violations']};if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/wax.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
