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

test('movable chalkboard retains the existing face, actions and attributed state',()=>{
 const lib=coreLibrary(),old=lib.get('core-chalkboard@2'),board=lib.get('core-chalkboard@3');
 assert.equal(old.components.carryable,undefined);
 for(const key of ['make','state','actions','size','params'])assert.deepEqual(board[key],old[key],key);
 assert.deepEqual(board.components.carryable,{mass:7,grips:2});assert.ok(board.tags.includes('upright-carry'));
});

test('native write, carry, read, rewrite and erase follow the same chalkboard and persist',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Moving a message'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();
 ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/chalkboard@3',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3],state:{text:'Distant message '+i,textBy:'s_other'}}))}));await tick(50);
 const distant=await here();assert.equal(bytes(distant),bytes(absent),'100 distant written copies add zero nearby bytes');assert.ok(!/Distant message|distant-/.test(JSON.stringify(distant.here)));
 ok(god.act({ops:[{op:'place',def:'core/chalkboard@3',name:'field-board',p:[x+2,z]},
 {op:'place',def:'core/chalkboard@2',name:'fixed-board',p:[x+5,z-3]},
 {op:'place',def:'core/chalkboard@3',name:'private-board',p:[x-4,z],access:'private'},
 {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.6,z-.6]},
 {op:'place',def:'core/zone@1',name:'display-spot',shape:{area:[[x+5,z+4],[x+7,z+4],[x+7,z+6],[x+5,z+6]]}}]}));await tick(50);
 const id=n=>[...god.model.entities.values()].find(e=>e.name===n).id,target=id('field-board'),state=()=>god.model.entities.get(target).state;
 const act=(capability,params={})=>accept(f.host,edge.act(soul,{capability,params}));
 const finish=async r=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params)=>{const r=await finish(await act(cap,params));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 const caps=edge.capabilities(soul),write=`object:${target}:write`,carry=`carry:${target}`;
 assert.ok(caps.find(c=>c.id===write)?.params.text);assert.ok(caps.find(c=>c.id===carry)?.params.to);
 assert.equal(caps.some(c=>c.id===`carry:${id('fixed-board')}`),false);
 for(const cap of [`carry:${id('private-board')}`,`object:${id('private-board')}:write`]){const denied=await act(cap,cap.startsWith('carry:')?{to:'display-spot'}:{text:'No'});assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),/private|access|owner/);}
 const note='Field notes\nLight between trees';await done(write,{text:note});assert.deepEqual(state(),{text:note,textBy:soul.soulId});
 const interrupted=ok(await act(write,{text:'Never finished'}));for(let n=0;n<400&&!body().human?.handActuator?.stroke;n++)await tick();
 assert.ok(body().human?.handActuator?.stroke);await done('stand:here');await tick(80);assert.notEqual(edge.receipt(soul.soulId,interrupted.receipt.id).phase,'completed');assert.equal(state().text,note);
 await done(`pick-up:${id('bowl')}`);const full=await act(carry,{to:'display-spot'});assert.equal(full.accepted,false);assert.match(JSON.stringify(full),/carry.hands-full/);await done('put-down:here');
 await done(carry,{to:'display-spot'});await tick(10);
 const native=f.host.engine.world.entities[target],saved=god.model.worldPose(god.model.entities.get(target));
 assert.equal(native.support.kind,'ground');assert.ok(Math.hypot(native.pose.p[0]-(x+6),native.pose.p[2]-(z+5))<.05);
 assert.ok(Math.hypot(saved.x-native.pose.p[0],saved.z-native.pose.p[2])<.001);assert.equal(state().text,note);assert.equal(state().textBy,soul.soulId);
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 assert.deepEqual(restored.entities.get(target).state,state());assert.deepEqual(restored.worldPose(restored.entities.get(target)),saved);
 const read=await done(`read:${target}`);assert.equal(read.outcome.detail.sign.text,note);assert.match(read.outcome.summary,/written by Ana/);assert.equal(read.outcome.untrusted,true);
 await done(write,{text:'Evening gathering here'});assert.equal(state().text,'Evening gathering here');assert.equal(state().textBy,soul.soulId);
 await done(`object:${target}:erase`);assert.deepEqual(state(),{text:'',textBy:''});assert.ok(!edge.capabilities(soul).some(c=>c.id===`read:${target}`));
 assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100Written:bytes(distant),nearby:bytes(await here())},finalPose:saved,checks:['unchanged writable face and frozen revision','100 distant written copies add zero nearby bytes','parameter discovery','private and full-hand refusals','interrupted write preserves prior text','same-entity upright carry','attributed read after relocation','rewrite and erase at destination','exact snapshot state and pose persistence','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/movable-chalkboard.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
