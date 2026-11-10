import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdirSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {WorldModel, containerInside} from '../../packages/world-compiler/src/index.ts';
import {TakeRecorder} from '../../mars/viewer/engine/take/recorder.ts';

test('actual bookcase composition: three books, selected retrieval, metadata, cancellation and persistence', {timeout:180000}, async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 const tick=async(n=5)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick();await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Bookcase test'}));soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick();
 const here=async()=>{const r=await app.request('/v1/edge/here?include=doHere');assert.equal(r.status,200);return(await r.json()).here;};
 const absent=await here();ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/bookcase@2',name:`distant-bookcase-${i}`,p:[120+i%10*2,120+Math.floor(i/10)*2]}))}));await tick(45);
 const far=await here();assert.equal(JSON.stringify(far).length,JSON.stringify(absent).length,'100 distant bookcases add zero compact context bytes');
 const distant=new Set([...god.model.entities.values()].filter(e=>e.name?.startsWith('distant-')).map(e=>e.id));const recorder=new TakeRecorder(f.host.engine.rt,{rulesVersion:'bookcase'});await tick(4);assert.ok(!Object.keys(recorder.finish().tracks).some(id=>distant.has(id)));
 assert.equal(god.act({ops:[{op:'place',def:'core/bookcase@2',name:'unsupported-construction',p:[30,30],params:{condition:'construction'}}]}).accepted,false,'construction is outside the declared cabinet finish domain');
 const body=()=>f.host.engine.world.entities[soul.entityId],ax=body().pose.p[0],az=body().pose.p[2];
 const books=[['red-book','#9a3b32'],['blue-book','#2f5d8b'],['green-book','#3f6b5c']];
 ok(god.act({ops:[{op:'place',def:'core/table@1',name:'table',p:[ax+2.4,az-.6]},
 {op:'place',def:'core/bookcase@2',name:'bookcase',p:[ax+1,az+2.6],r:Math.PI},
 {op:'place',def:'core/bookcase@2',name:'private-bookcase',p:[ax+4.5,az+2.6],r:Math.PI,owner:'god',access:'private'},
 ...books.map(([name,cover],i)=>({op:'place',def:'core/book@1',name,in:{parent:'table',slot:'top'},p:[-.3+i*.3,0],params:{cover},owner:'soul:Ana',about:{title:name,what:'Collection credit: Ana; a named physical volume, not an authored passage binding.'}})),
 {op:'place',def:'core/letter@1',name:'letter',in:{parent:'table',slot:'top'},p:[0,.25]},
 {op:'place',def:'core/lantern@3',name:'lantern',in:{parent:'table',slot:'top'},p:[0,-.25],state:{on:false}}]}));await tick(60);
 const ent=n=>{const e=[...god.model.entities.values()].find(e=>e.name===n);assert.ok(e,n);return e;};const shelf=ent('bookcase').id,ids=books.map(([n])=>ent(n).id),item=id=>f.host.engine.world.entities[id];
 const metadata=new Map(ids.map(id=>{const e=god.model.entities.get(id);return[id,{name:e.name,params:structuredClone(e.params),about:structuredClone(e.about),owner:e.owner}];}));
 const act=async(capability,accepted=true)=>{const r=await accept(f.host,app.request('/v1/edge/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability})}));const b=await r.json();assert.equal(b.accepted,accepted,JSON.stringify(b));return b;};
 const done=async cap=>{const r=await act(cap);for(let i=0;i<1600;i++){const x=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','cancelled','replaced'].includes(x.phase)){assert.equal(x.phase,'completed',JSON.stringify(x));return x;}await tick(1);}throw Error('receipt timeout');};
 for(const id of ids){await done(`pick-up:${id}`);assert.ok(edge.capabilities(soul).find(c=>c.id===`put-in:${shelf}`)?.available);await done(`put-in:${shelf}`);assert.equal(item(id).support.kind,'resting-on');assert.equal(item(id).support.on,shelf);assert.equal(god.model.entities.get(id).in.parent,shelf);}
 assert.equal(new Set(ids.map(id=>item(id).support.slot)).size,3,'three separate shelf places');
 const full=await here();assert.equal(full.objects.find(o=>o.id===shelf).state.holds.length,3);for(const[name]of books)assert.ok(full.objects.find(o=>o.id===shelf).state.holds.some(s=>s.includes(name)),name+' discovered');
 await done(`pick-up:${ent('letter').id}`);assert.equal((await act(`put-in:${ent('private-bookcase').id}`,false)).code,'object.private');assert.equal((await act(`put-in:${shelf}`,false)).code,'container.full');await done(`put-on:${ent('table').id}`);
 const saved=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);const clone=factory.restore(f.host.engine.snapshot());assert.equal(clone.stateHash(),f.host.engine.stateHash());
 for(const id of ids){assert.equal(saved.entities.get(id).in.parent,shelf);assert.equal(clone.world.entities[id].support.on,shelf);const e=saved.entities.get(id);assert.deepEqual({name:e.name,params:e.params,about:e.about,owner:e.owner},metadata.get(id));}
 const chosen=ids[1];await done(`pick-up:${chosen}`);assert.equal(item(chosen).support.by,soul.entityId);assert.ok(ids.filter(id=>id!==chosen).every(id=>item(id).support.on===shelf));
 const after=await here();assert.equal(after.objects.find(o=>o.id===shelf).state.holds.length,2);assert.ok(!after.objects.find(o=>o.id===shelf).state.holds.some(s=>s.includes('blue-book')));
 const e=god.model.entities.get(chosen);assert.deepEqual({name:e.name,params:e.params,about:e.about,owner:e.owner},metadata.get(chosen));
 const interrupted=await act(`put-in:${shelf}`);await act('stand:here');await tick(70);assert.equal(edge.receipt(soul.soulId,interrupted.receipt.id).phase,'replaced');assert.equal(item(chosen).support.kind,'in-hand');
 await done(`put-in:${shelf}`);await done(`pick-up:${ent('lantern').id}`);assert.equal((await act(`put-in:${shelf}`,false)).code,'item.does-not-fit');
 assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',books:3,selectedBook:'blue-book',metadataPreserved:true,snapshot:true,cancelBeforeHandoff:true,hereBytes:{absent:JSON.stringify(absent).length,distant100:JSON.stringify(far).length}};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(`${process.env.SOUL_ACTIONS_OUT}/summary.json`,JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
