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

test('camp bench retains the repairable geometry, seats and frozen revisions',()=>{
 const lib=coreLibrary(),old=lib.get('core-bench@2'),bench=lib.get('core-bench@3');
 assert.equal(old.components.carryable,undefined);
 for(const key of ['make','state','actions','size','params','slots'])assert.deepEqual(bench[key],old[key],key);
 assert.deepEqual(bench.components.repairable,old.components.repairable);
 assert.deepEqual(bench.components.carryable,{mass:24,grips:2});assert.ok(bench.tags.includes('upright-carry'));
});

test('native damaged bench travels to camp, is repaired and sat on there, preserving identity and persistence',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 const join=async name=>{await invite(f,name.toLowerCase());const row=await accept(f.host,f.souls.create('dev:'+name.toLowerCase(),{name,description:'A bench at camp'}));await tick(5);return {soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};};
 await tick(5);const ana=await join('Ana'),ben=await join('Ben');soul=ana;
 const body=s=>f.host.engine.world.entities[s.entityId],[x,,z]=body(ana).pose.p;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();
 ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/bench@3',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3],state:{broken:true}}))}));await tick(50);
 const distant=await here();assert.equal(bytes(distant),bytes(absent),'100 distant damaged benches add zero nearby bytes');assert.ok(!/distant-/.test(JSON.stringify(distant.here)));
 ok(god.act({ops:[{op:'place',def:'core/bench@3',name:'camp-bench',p:[x+2,z],state:{broken:true}},
 {op:'place',def:'core/bench@2',name:'fixed-bench',p:[x+5,z-3]},
 {op:'place',def:'core/bench@3',name:'private-bench',p:[x-4,z],access:'private',state:{broken:true}},
 {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.6,z-.6]},
 {op:'place',def:'core/zone@1',name:'campsite',shape:{area:[[x+5,z+4],[x+7,z+4],[x+7,z+6],[x+5,z+6]]}}]}));await tick(50);
 const id=n=>[...god.model.entities.values()].find(e=>e.name===n).id,target=id('camp-bench'),state=()=>god.model.entities.get(target).state;
 const act=(capability,params={},s=ana)=>accept(f.host,edge.act(s,{capability,params}));
 const finish=async(r,s=ana)=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(s.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params,s=ana)=>{const r=await finish(await act(cap,params,s),s);assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 const caps=edge.capabilities(ana),repair=`object:${target}:repair`,carry=`carry:${target}`;
 assert.ok(caps.find(c=>c.id===carry)?.params.to);assert.equal(caps.find(c=>c.id===repair)?.blocked?.code,'repair.no-tool');
 assert.equal(caps.some(c=>c.id===`carry:${id('fixed-bench')}`),false);
 const denied=await act(`carry:${id('private-bench')}`,{to:'campsite'});assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),/object.private/);
 await done(`pick-up:${id('bowl')}`);const full=await act(carry,{to:'campsite'});assert.equal(full.accepted,false);assert.match(JSON.stringify(full),/carry.hands-full/);await done('put-down:here');
 await done(carry,{to:'campsite'});await tick(10);
 const native=f.host.engine.world.entities[target],saved=god.model.worldPose(god.model.entities.get(target));
 assert.equal(native.support.kind,'ground');assert.ok(Math.hypot(native.pose.p[0]-(x+6),native.pose.p[2]-(z+5))<.05);
 assert.ok(Math.hypot(saved.x-native.pose.p[0],saved.z-native.pose.p[2])<.001);assert.equal(state().broken,true,'transport does not repair it');
 ok(god.act({ops:[{op:'place',def:'core/hammer@1',name:'hammer',p:[x+4,z+4]}]}));await tick(30);
 const working=()=>f.host.engine.rt.holder('actor:'+ana.entityId).map(id=>f.host.engine.rt.records.get(id)).find(r=>r?.verb==='repair_v1');
 const interrupted=ok(await act(repair));for(let n=0;n<1200&&!working();n++)await tick();assert.ok(working());await tick(20);
 await done('stand:here');await tick(80);assert.notEqual(edge.receipt(ana.soulId,interrupted.receipt.id).phase,'completed');assert.equal(state().broken,true);
 const repairing=ok(await act(repair));let early=false;
 for(let n=0;n<1500&&edge.receipt(ana.soulId,repairing.receipt.id).phase!=='completed';n++){if(working()&&state().broken!==true)early=true;await tick();}
 assert.equal((await finish(repairing)).phase,'completed');assert.equal(early,false);assert.equal(state().broken,false);assert.equal(state().repairedBy,repairing.receipt.id);
 assert.equal(f.host.engine.world.entities[id('hammer')].support.by,ana.entityId,'real hammer retained');
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 assert.deepEqual(restored.entities.get(target).state,state());assert.deepEqual(restored.worldPose(restored.entities.get(target)),saved);
 await done(`sit:${target}`,{seconds:1});assert.equal(f.host.engine.bodyUsesV1(target)?.body,ana.entityId);
 assert.ok(Math.hypot(body(ana).pose.p[0]-saved.x,body(ana).pose.p[2]-saved.z)<1.2,'sits at actual relocated bench');
 await done('stand:here');await tick(40);await done(`sit:${target}`,{seconds:1},ben);
 const occupied=await act(carry,{to:'Green field'});assert.equal(occupied.accepted,false);assert.match(JSON.stringify(occupied),/carry.occupied/);await done('stand:here',{},ben);
 assert.equal(state().broken,false);assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100Damaged:bytes(distant),nearby:bytes(await here())},finalPose:saved,finalState:state(),checks:['frozen revisions and repair geometry unchanged','100 distant damaged copies add zero nearby bytes','tool and carry discovery','private/full-hand/occupied refusals','real damaged-bench transport','interrupted repair stays broken','on-site hammer repair completion and retained tool','actual relocated seat used','exact snapshot state and pose persistence','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/camp-bench.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
