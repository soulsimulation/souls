// #1495: real native contact and durable entity state, using only fake minds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture,invite,accept,factory,seed} from '../../apps/server/test/native-owner-fixture.ts';
import {Db} from '../../apps/server/src/db.ts';
import {WorldHost} from '../../apps/server/src/world.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

test('incense: real tip contact, offers, refusals, cancellation, restart and zero distant context cost', {timeout:120000}, async t=>{
 const dir=mkdtempSync(join(tmpdir(),'incense-native-')),path=join(dir,'world.db'),f=fixture(path,factory,{durableClockV1:true});f.brain.quiesce();
 let host=f.host,db=f.db,god,edge,app,comms,soul;
 const attach=()=>{
  god=new GodMode(db,{worldId:host.worldId,ownerId:'dev:admin',tick:()=>host.engine.world.tick,emit(){},assetDir:dir});
  edge=new EdgeLedger(host,db,undefined,{ambient:false});app=new Hono();
  comms=mountEdgeRoutes(app,{host,db,souls:f.souls,ledger:edge,soul:()=>soul});
  installEngineBridge({host,god,edge,log(){},worldLore:false,worldClock:false});
 };attach();
 t.after(()=>{comms.close();host.stop();if(db.db.isOpen)db.close();rmSync(dir,{recursive:true,force:true});});
 const tick=async(n=5)=>{for(let i=0;i<n;i++){host.tickOnce();await setImmediate();host.drainInputs();}};
 await tick();await invite(f,'ana');const row=await accept(host,f.souls.create('dev:ana',{name:'Ana',description:'Incense contact test'}));
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick();
 const here=async()=>{const r=await app.request('/v1/edge/here?include=doHere');assert.equal(r.status,200);return (await r.json()).here;};
 const absent=await here();
 const distant=Array.from({length:100},(_,i)=>({op:'place',def:'core/incense-censer@1',name:`distant-incense-${i}`,p:[120+i%10*3,120+Math.floor(i/10)*3],state:{on:true}}));
 assert.equal(god.act({ops:distant}).accepted,true);await tick(45);const far=await here();
 const normalized=h=>JSON.stringify({...h,tick:0,now:'',clock:'',light:'',day:'',doHereCoverage:{...h.doHereCoverage,byteBudget:0}});
 assert.equal(normalized(far),normalized(absent),'100 lit distant censers add zero local context');
 const body=()=>host.engine.world.entities[soul.entityId],[x,,z]=body().pose.p;
 assert.equal(god.act({ops:[{op:'place',def:'core/incense-censer@1',name:'incense',p:[x+1.5,z+1.5],r:.6},
  {op:'place',def:'core/incense-censer@1',name:'private-incense',p:[x-1.5,z+1.5],owner:'soul:s_other',access:'private'}]}).accepted,true);await tick(45);
 const target=god.model.get('incense').id,privateId=god.model.get('private-incense').id,state=()=>god.model.entities.get(target).state;
 const inspect=await app.request(`/v1/edge/inspect/${target}`);assert.equal(inspect.status,200);const inspected=(await inspect.json()).inspect;
 assert.ok(inspected.offers.some(o=>o.id===`object:${target}:light`&&o.available&&o.label.includes('incense')),'actual inspector exposes the hand lighting offer');
 const act=async(capability,accepted=true)=>{const r=await accept(host,app.request('/v1/edge/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability})}));const b=await r.json();assert.equal(b.accepted,accepted,JSON.stringify(b));return b;};
 const refused=await act(`object:${privateId}:light`,false);assert.ok(refused.code);assert.match(refused.reason,/private|not yours/i);
 assert.equal(edge.openReceipts(soul.soulId).length,0);assert.equal(god.model.entities.get(privateId).state.on,false);
 await act('put out the incense',false);
 const cancel=async(words,want)=>{
  const r=await act(words);for(let i=0;i<600&&!body().human?.handActuator;i++)await tick(1);
  assert.ok(body().human?.handActuator,'a real native reach began');await tick(4);
  assert.equal((await accept(host,edge.act(soul,{capability:'stand:here'}))).accepted,true);await tick(60);
  assert.equal(state().on,want,'cancel before contact preserves burning state');
  assert.ok(['failed','cancelled','replaced'].includes(edge.receipt(soul.soulId,r.receipt.id).phase));
 };
 await cancel('light the incense',false);
 const finish=async(words,want)=>{
  const r=await act(words);assert.notEqual(state().on,want,'admission does not switch the censer');let contact=false;
  const wp=god.model.worldPose(god.model.entities.get(target)),expected=[wp.x+.025*Math.cos(wp.yaw)+.02*Math.sin(wp.yaw),wp.y+1.093,wp.z-.025*Math.sin(wp.yaw)+.02*Math.cos(wp.yaw)];
  for(let i=0;i<600;i++){
   const m=body().human?.handActuator;
   if(m){contact=true;assert.ok(Math.hypot(...m.at.map((v,k)=>v-expected[k]))<.005,'the actual hand target is the visible incense tip');
    if((host.engine.world.tick-m.startTick)*host.engine.dt<.6)assert.notEqual(state().on,want,'nothing changes early');}
   const phase=edge.receipt(soul.soulId,r.receipt.id).phase;if(!['waiting','started'].includes(phase))break;await tick(1);
  }
  assert.equal(edge.receipt(soul.soulId,r.receipt.id).phase,'completed');assert.ok(contact);assert.equal(state().on,want);return r;
 };
 await finish('light the incense',true);await act('light the incense',false);
 await cancel('put out the incense',true);
 const before={...state()};comms.close();host.stop();host.drainInputs();assert.ok(host.engine.canSnapshot?.()!==false);host.saveSnapshot(true);
 const worldId=host.worldId;db.close();db=new Db(path);host=new WorldHost(db,factory,seed,1e9,worldId,{durableClockV1:true});assert.equal(host.boot().from,'snapshot');host.drainInputs();attach();
 assert.deepEqual(state(),before,'SQLite and engine snapshot restore the burning censer');await tick(5);
 await finish('put out the incense',false);await act('put out the incense',false);await finish('light the incense',true);
 const near=await here(),rowNear=near.objects.find(o=>o.id===target);assert.deepEqual(rowNear.state,{on:true});
 assert.deepEqual(host.engine.runtime.violations,[]);
 const summary={status:'pass',hereBytes:{absent:JSON.stringify(absent).length,distant100:JSON.stringify(far).length,normalizedDistantDelta:normalized(far).length-normalized(absent).length,nearby:JSON.stringify(near).length},privateRefusal:refused.code,checks:['real tip contact before state change','light/put-out/on again','both pre-contact cancellations','existing private access refusal','inspector offer','SQLite and snapshot burning state','zero engine violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(join(process.env.SOUL_ACTIONS_OUT,'incense-summary.json'),JSON.stringify(summary,null,2));}console.log(JSON.stringify(summary));
});
