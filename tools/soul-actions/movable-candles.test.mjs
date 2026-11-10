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

test('movable candle retains the frozen wick, flame, light, state and actions',()=>{
 const lib=coreLibrary(),old=lib.get('core-candle-stand@1'),stand=lib.get('core-candle-stand@2');
 assert.equal(old.components.carryable,undefined);
 for(const key of ['make','state','actions','size','params'])assert.deepEqual(stand[key],old[key],key);
 assert.deepEqual(stand.components.light,old.components.light);assert.deepEqual(stand.components.carryable,{mass:5,grips:2});assert.ok(stand.tags.includes('upright-carry'));
});

test('native stands are arranged, lit and extinguished at their actual moved positions, preserving independent state',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Arranging candles'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const body=()=>f.host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();
 ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/candle-stand@2',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3],state:{on:i%2===0}}))}));await tick(50);
 const distant=await here();assert.equal(bytes(distant),bytes(absent),'100 distant stands add zero nearby bytes');assert.ok(!/distant-/.test(JSON.stringify(distant.here)));
 ok(god.act({ops:[{op:'place',def:'core/candle-stand@2',name:'first-candle',p:[x+2,z]},
 {op:'place',def:'core/candle-stand@2',name:'second-candle',p:[x-2,z]},
 {op:'place',def:'core/candle-stand@1',name:'fixed-candle',p:[x+5,z-3]},
 {op:'place',def:'core/candle-stand@2',name:'private-candle',p:[x-4,z],access:'private'},
 {op:'place',def:'core/bowl@2',name:'bowl',p:[x+.6,z-.6]},
 ...[['left-place',x-3],['right-place',x+3]].map(([name,a])=>({op:'place',def:'core/zone@1',name,shape:{area:[[a-1,z+3],[a+1,z+3],[a+1,z+5],[a-1,z+5]]}}))]}));await tick(50);
 const ent=n=>[...god.model.entities.values()].find(e=>e.name===n),id=n=>ent(n).id,state=n=>ent(n).state,native=n=>f.host.engine.world.entities[id(n)];
 const act=(capability,params={})=>accept(f.host,edge.act(soul,{capability,params}));
 const finish=async r=>{ok(r);for(let n=0;n<2000;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('finite action did not end');};
 const done=async(cap,params)=>{const r=await finish(await act(cap,params));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 assert.ok(edge.capabilities(soul).find(c=>c.id==='carry:'+id('first-candle'))?.params.to);
 assert.equal(edge.capabilities(soul).some(c=>c.id==='carry:'+id('fixed-candle')),false);
 for(const cap of ['carry:'+id('private-candle'),'object:'+id('private-candle')+':light']){const denied=await act(cap,cap.startsWith('carry:')?{to:'right-place'}:{});assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),/private|access|owner/);}
 await done('pick-up:'+id('bowl'));const full=await act('carry:'+id('first-candle'),{to:'right-place'});assert.equal(full.accepted,false);assert.match(JSON.stringify(full),/carry.hands-full/);await done('put-down:here');
 const poses={};for(const [name,dest,a]of [['first-candle','right-place',x+3],['second-candle','left-place',x-3]]){
  const identity=id(name);await done('carry:'+identity,{to:dest});await tick(10);const p=native(name).pose.p;
  assert.equal(id(name),identity);assert.equal(native(name).support.kind,'ground');assert.ok(Math.hypot(p[0]-a,p[2]-(z+4))<.05);assert.equal(state(name).on,false);
  poses[name]=god.model.worldPose(ent(name));assert.ok(Math.hypot(poses[name].x-p[0],poses[name].z-p[2])<.001);
 }
 const first=id('first-candle'),cut=ok(await act('object:'+first+':light'));for(let n=0;n<800&&!body().human?.handActuator;n++)await tick();assert.ok(body().human?.handActuator);await tick(4);
 await done('stand:here');await tick(60);assert.notEqual(edge.receipt(soul.soulId,cut.receipt.id).phase,'completed');assert.equal(state('first-candle').on,false);
 const contacts=[];
 for(const [name,on]of [['first-candle',true],['second-candle',true],['first-candle',false]]){
  const target=id(name),r=ok(await act('object:'+target+':'+(on?'light':'put-out')));assert.notEqual(state(name).on,on,'admission has no remote on/off effect');let saw=false,early=false,contactAt=null;
  for(let n=0;n<1000&&edge.receipt(soul.soulId,r.receipt.id).phase!=='completed';n++){
   const m=body().human?.handActuator;if(m&&m.target===target){saw=true;contactAt??=[...m.at];assert.equal(m.at[0],poses[name].x);assert.equal(m.at[2],poses[name].z);assert.ok(m.at[1]>1.2&&m.at[1]<1.3,'existing wick height');if((f.host.engine.world.tick-m.startTick)*f.host.engine.dt<.6&&state(name).on===on)early=true;}
   await tick();
  }
  assert.equal((await finish(r)).phase,'completed');assert.ok(saw);assert.equal(early,false);assert.equal(state(name).on,on);contacts.push({name,on,at:contactAt});
 }
 assert.equal(state('first-candle').on,false);assert.equal(state('second-candle').on,true);
 await done('walk:left-place');await tick(20);
 const near=await here();assert.deepEqual(near.here.objects.find(o=>o.id===id('second-candle'))?.state,{on:true});
 assert.ok(edge.capabilities(soul).some(c=>c.id==='object:'+first+':light'));assert.ok(edge.capabilities(soul).some(c=>c.id==='object:'+id('second-candle')+':put-out'));
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
 for(const name of ['first-candle','second-candle']){assert.deepEqual(restored.entities.get(id(name)).state,state(name));assert.deepEqual(restored.worldPose(restored.entities.get(id(name))),poses[name]);}
 assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100Stands:bytes(distant),nearby:bytes(near)},poses,contacts,checks:['frozen wick/flame/light/actions unchanged','100 distant stands add zero nearby bytes','two real stands moved to chosen places','actual wick contact follows relocated world pose','independent contact-timed on/off state','private/full-hand refusals','interrupted contact preserves off state','current discovery','exact snapshot state/placement persistence','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/candles.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
