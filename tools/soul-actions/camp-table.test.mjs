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

test('camp table is an opt-in solo carry revision with the original real surface',()=>{
 const lib=coreLibrary(),old=lib.get('core-table@1'),table=lib.get('core-table@2');
 assert.equal(old.components.carryable,undefined);
 for(const key of ['make','slots','size','params','state','actions'])assert.deepEqual(table[key],old[key],key);
 assert.deepEqual(table.components.surface,old.components.surface);
 assert.deepEqual(table.components.carryable,{mass:15,grips:2});assert.ok(table.tags.includes('upright-carry'));
 assert.equal(lib.get('core-work-table@1').components.carryable.mass,75,'crew work table is unchanged');
});

test('native empty table moves to camp, supports selected equipment and persists without loaded transport',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Setting up camp'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();
 const distantOps=Array.from({length:100},(_,i)=>[
  {op:'place',def:'core/table@2',name:'distant-table-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3]},
  {op:'place',def:'core/bowl@2',name:'distant-bowl-'+i,in:{parent:'distant-table-'+i,slot:'top'},p:[.25,0]},
  {op:'place',def:'core/lantern@3',name:'distant-lantern-'+i,in:{parent:'distant-table-'+i,slot:'top'},p:[-.25,0],state:{on:false}},
 ]).flat();for(let i=0;i<distantOps.length;i+=150)ok(god.act({ops:distantOps.slice(i,i+150)}));await tick(50);
 const far=await here();assert.equal(bytes(far),bytes(absent),'100 distant staged tables add zero nearby bytes');assert.ok(!/distant-/.test(JSON.stringify(far.here)));
 ok(god.act({ops:[{op:'place',def:'core/table@2',name:'camp-table',p:[x+2,z]},
  {op:'place',def:'core/table@1',name:'fixed-table',p:[x+5,z-3]},
  {op:'place',def:'core/table@2',name:'private-table',p:[x-4,z],access:'private'},
  {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.5,z-1]},
  {op:'place',def:'core/lantern@3',name:'lantern',in:{parent:'fixed-table',slot:'top'},p:[-.25,0],state:{on:false}},
  {op:'place',def:'core/zone@1',name:'campsite',shape:{area:[[x+2,z+3],[x+4,z+3],[x+4,z+5],[x+2,z+5]]}}]}));await tick(50);
 const ent=n=>[...god.model.entities.values()].find(e=>e.name===n),id=n=>ent(n).id,native=n=>f.host.engine.world.entities[id(n)];
 const act=(capability,params={})=>accept(f.host,edge.act(soul,{capability,params}));
 const finish=async r=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params)=>{const r=await finish(await act(cap,params));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 assert.ok(edge.capabilities(soul).find(c=>c.id==='carry:'+id('camp-table'))?.params.to);
 assert.equal(edge.capabilities(soul).some(c=>c.id==='carry:'+id('fixed-table')),false);
 const denied=await act('carry:'+id('private-table'),{to:'campsite'});assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),/private|access|owner/);
 await done('pick-up:'+id('bowl'));const full=await act('carry:'+id('camp-table'),{to:'campsite'});assert.equal(full.accepted,false);assert.match(JSON.stringify(full),/carry.hands-full/);await done('put-down:here');
 const tableId=id('camp-table');await done('carry:'+tableId,{to:'campsite'});await tick(10);
 assert.equal(id('camp-table'),tableId);assert.equal(native('camp-table').support.kind,'ground');
 const tablePose=god.model.worldPose(ent('camp-table'));assert.ok(Math.hypot(tablePose.x-(x+3),tablePose.z-(z+4))<.05);
 await done('pick-up:'+id('bowl'));
 const interrupted=ok(await act('put-on:'+tableId));for(let n=0;n<800&&!body().human?.itemTransferV1?.reachTick;n++)await tick();assert.ok(body().human?.itemTransferV1?.reachTick);await tick(6);
 await done('stand:here');await tick(60);assert.notEqual(edge.receipt(soul.soulId,interrupted.receipt.id).phase,'completed');assert.equal(native('bowl').support.kind,'in-hand');
 for(const name of ['bowl','lantern']){
  if(name==='lantern')await done('pick-up:'+id(name));
  assert.ok(edge.capabilities(soul).find(c=>c.id==='put-on:'+tableId)?.available);
  await done('put-on:'+tableId);await tick(10);
  assert.equal(native(name).support.kind,'resting-on');assert.equal(native(name).support.on,tableId);assert.equal(ent(name).in.parent,tableId);assert.equal(ent(name).in.slot,'top');assert.match(native(name).support.slot,/^top-r\d+c\d+$/);
  const p=god.model.worldPose(ent(name));assert.ok(Math.abs(p.x-tablePose.x)<.6&&Math.abs(p.z-tablePose.z)<.4);assert.ok(p.y>=.75,'actual relocated surface height');
 }
 const staged=Object.fromEntries(['camp-table','bowl','lantern'].map(n=>[n,JSON.parse(JSON.stringify(ent(n)))]));
 const loaded=await act('carry:'+tableId,{to:'field'});const rejected=loaded.accepted?await finish(loaded):loaded;
 assert.notEqual(rejected.phase,'completed');assert.match(JSON.stringify(rejected),/move_fixture.contents/);
 for(const n of ['camp-table','bowl','lantern'])assert.deepEqual(JSON.parse(JSON.stringify(ent(n))),staged[n],'loaded refusal preserves '+n);
 const lanternPose=[...native('lantern').pose.p];await done('pick-up:'+id('bowl'));
 assert.equal(native('bowl').support.kind,'in-hand');assert.equal(native('bowl').support.by,soul.entityId);assert.deepEqual(native('lantern').pose.p,lanternPose);assert.equal(native('lantern').support.on,tableId);
 await done('put-on:'+tableId);await tick(10);
 const near=await here();if(process.env.SOUL_ACTIONS_OUT)writeFileSync(process.env.SOUL_ACTIONS_OUT+'/near.json',JSON.stringify(near,null,2));assert.ok(edge.capabilities(soul).some(c=>c.id==='carry:'+tableId));assert.ok(edge.capabilities(soul).some(c=>c.id==='pick-up:'+id('bowl')));
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 for(const n of ['camp-table','bowl','lantern']){assert.deepEqual(restored.entities.get(id(n)),JSON.parse(JSON.stringify(ent(n))));assert.deepEqual(restored.worldPose(restored.entities.get(id(n))),god.model.worldPose(ent(n)));}
 assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100StagedTables:bytes(far),nearby:bytes(near)},tablePose,items:['bowl','lantern'].map(n=>({name:n,id:id(n),support:native(n).support,pose:god.model.worldPose(ent(n))})),loadedRefusal:rejected,checks:['same empty table moved to chosen campsite','real relocated surface supports lantern and bowl','selected retrieval preserves other item','private/full hands/loaded refusal','interrupted placement retains custody','same identities and exact snapshot persistence','100 distant staged tables add zero nearby bytes','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/table.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
