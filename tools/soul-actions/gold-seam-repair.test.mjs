import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture,invite,accept,factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {coreLibrary,WorldModel} from '../../packages/world-compiler/src/index.ts';

test('native ceramic art restoration fetches a brush, changes only on completion and persists',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});const bridge=installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};await tick(5);await invite(f,'artist');const row=await accept(f.host,f.souls.create('dev:artist',{name:'Ana',description:'Restoring ceramic artwork'}));soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;const absent=await here();
 for(const key of ['core-gold-seam-station@1','core-lacquer-brush@1'])ok(god.act({ops:[{op:'define',def:coreLibrary().get(key)}]}));
 ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/gold-seam-station@1',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3]}))}));await tick(45);const far=await here();assert.equal(bytes(far),bytes(absent));assert.ok(!/distant-/.test(JSON.stringify(far.here)));
 ok(god.act({ops:[{op:'place',def:'core/gold-seam-station@1',name:'artwork',p:[x+2,z]},{op:'place',def:'core/gold-seam-station@1',name:'private-artwork',p:[x-3,z],access:'private'},{op:'place',def:'core/lacquer-brush@1',name:'private-brush',p:[x+1,z-1],access:'private'}]}));await tick(45);
 const ent=n=>[...god.model.entities.values()].find(e=>e.name===n),id=ent('artwork').id,cap='object:'+id+':repair';
 const act=(capability)=>accept(f.host,edge.act(soul,{capability,params:{}})),receipt=r=>edge.receipt(soul.soulId,r.receipt.id);
 const finish=async r=>{ok(r);for(let i=0;i<1600;i++){const end=receipt(r);if(['completed','failed','replaced','cancelled'].includes(end.phase))return end;await tick();}assert.fail('finite repair did not end');};
 const work=()=>f.host.engine.rt.holder('actor:'+soul.entityId).map(id=>f.host.engine.rt.records.get(id)).find(r=>r?.verb==='repair_v1');
 const privateTarget=await act('object:'+ent('private-artwork').id+':repair');assert.equal(privateTarget.accepted,false);assert.match(JSON.stringify(privateTarget),/private|access|owner/);
 const noTool=await act(cap);assert.equal(noTool.accepted,false);assert.match(JSON.stringify(noTool),/repair.no-tool/);assert.equal(ent('artwork').state.broken,true);
 ok(god.act({ops:[{op:'place',def:'core/lacquer-brush@1',name:'brush',p:[x+.8,z]}]}));await tick(30);
 const near=await here();assert.ok(JSON.stringify(near).includes('a cracked ceramic bowl'));assert.equal(edge.capabilities(soul).find(c=>c.id===cap)?.available,true);
 const interrupted=ok(await act(cap));for(let i=0;i<800&&!work();i++)await tick();assert.ok(work(),'native repair starts after fetching the brush');await tick(20);assert.equal(ent('artwork').state.broken,true);const stop=await finish(await act('stand:here'));assert.equal(stop.phase,'completed');await tick(50);assert.notEqual(receipt(interrupted).phase,'completed');assert.equal(ent('artwork').state.broken,true);assert.equal(ent('artwork').state.repairedBy,'');
 const repair=ok(await act(cap));let active=0;for(let i=0;i<1200&&receipt(repair).phase!=='completed';i++){if(work()){active++;assert.equal(ent('artwork').state.broken,true,'raw material until completed receipt');}await tick();}
 const end=await finish(repair);assert.equal(end.phase,'completed',JSON.stringify(end));await tick(5);assert.ok(active>20,'bounded repeated native brush work');assert.equal(ent('artwork').id,id);assert.equal(ent('artwork').state.broken,false);assert.equal(ent('artwork').state.repairedBy,end.id,'durable receipt provenance, not an invented display author');
 const brush=ent('brush');assert.equal(f.host.engine.world.entities[brush.id].support.kind,'in-hand');assert.equal(f.host.engine.world.entities[brush.id].support.by,soul.entityId);assert.ok(JSON.stringify(end.outcome).includes('lacquer-brush'));
 await tick(45);assert.equal(edge.capabilities(soul).find(c=>c.id===cap),undefined,'whole artwork has no remaining repair offer');const repeat=await act(cap);assert.equal(repeat.accepted,false);assert.equal(ent('artwork').state.broken,false,'a stale whole-artwork request cannot undo restoration');
 const before=JSON.stringify(ent('artwork'));bridge.mending.onReceipt(end);assert.equal(JSON.stringify(ent('artwork')),before,'duplicate completion is idempotent');
 const snapshot=JSON.parse(JSON.stringify(god.model.snapshot())),restored=WorldModel.fromSnapshot(snapshot,undefined,god.model.library);assert.deepEqual(restored.entities.get(id),JSON.parse(JSON.stringify(ent('artwork'))));assert.deepEqual(f.host.engine.rt.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100:bytes(far),nearby:bytes(await here())},activeNativeTicks:active,broken:false,receiptProvenanceMatches:true,toolHeld:true,duplicateIdempotent:true,snapshotExact:true,nativeViolations:0};console.log(JSON.stringify(report));if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/gold-seam-repair.json',JSON.stringify(report,null,2));}
});
