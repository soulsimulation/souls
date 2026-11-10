import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {WorldModel} from '../../packages/world-compiler/src/model.ts';

test('a blank poetry folio becomes one finished, credited, readable poem through native hand writing', {timeout:180000}, async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
 const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});
 t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
 await tick(5);await invite(f,'poet');const row=await accept(f.host,f.souls.create('dev:poet',{name:'Ana',description:'Poetry test'}));await tick(5);
 soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};
 const body=()=>f.host.engine.world.entities[soul.entityId], here=async()=> (await (await app.request('/v1/edge/here?include=doHere')).json()).here;
 const absent=await here();
 assert.equal(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/poetry-folio@1',name:`far-folio-${i}`,p:[120+i%10*3,120+Math.floor(i/10)*3],state:{text:'far away poem',textBy:'s_poet'}}))}).accepted,true);await tick(45);
 const distant=await here(),strip=h=>JSON.stringify({...h,tick:0});assert.equal(strip(distant),strip(absent));
 const [x,,z]=body().pose.p;assert.equal(god.act({ops:[{op:'place',def:'core/poetry-folio@1',name:'poem',p:[x,z+2.6],r:Math.PI}]}).accepted,true);await tick(45);
 const e=()=>god.model.get('poem'),cap=`object:${e().id}:write`,near=await here();
 const offer=edge.capabilities(soul).find(c=>c.id===cap);assert.ok(offer?.available);assert.equal(offer.params.text.maxLength,100);assert.ok(!edge.capabilities(soul).some(c=>c.id===`object:${e().id}:erase`));
 const act=async(capability,params)=>{const r=await accept(f.host,app.request('/v1/edge/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({capability,...(params?{params}:{})})}));return r.json();};
 for(const text of ['', 'x'.repeat(101),'one\ntwo\nthree\nfour','bad\u0007']){const r=await act(cap,{text});assert.equal(r.accepted,false,JSON.stringify(r));assert.equal(r.code,'capability.params');assert.equal(e().state.text,'');}
 const cut=await act(cap,{text:'Unfinished'});assert.equal(cut.accepted,true,JSON.stringify(cut));await tick(3);assert.equal((await act('stand:here')).accepted,true);await tick(90);assert.equal(e().state.text,'');assert.notEqual(edge.receipt(soul.soulId,cut.receipt.id).phase,'completed');
 const text='Rain on the roof\nA small light in the window\nSomeone is awake';
 const write=await act(cap,{text});assert.equal(write.accepted,true,JSON.stringify(write));let stroke,early=false;
 for(let i=0;i<900;i++){const m=body().human?.handActuator;if(m?.stroke){stroke=m.stroke;if((f.host.engine.world.tick-m.startTick)*f.host.engine.dt<.65+m.stroke.seconds-.05&&e().state.text)early=true;}if(['completed','failed','cancelled','replaced'].includes(edge.receipt(soul.soulId,write.receipt.id)?.phase))break;await tick();}
 assert.equal(edge.receipt(soul.soulId,write.receipt.id).phase,'completed',JSON.stringify(edge.receipt(soul.soulId,write.receipt.id)));assert.equal(stroke.kind,'write');assert.equal(early,false);assert.equal(e().state.text,text);assert.equal(e().state.textBy,soul.soulId);
 const blocked=edge.capabilities(soul).find(c=>c.id===cap);assert.ok(!blocked?.available,'no available rewrite');const again=await act(cap,{text:'replacement'});assert.equal(again.accepted,false);assert.equal(again.code,'object.state');assert.equal(e().state.text,text);
 const read=await act(`read:${e().id}`);assert.equal(read.accepted,true,JSON.stringify(read));for(let i=0;i<900&&!['completed','failed'].includes(edge.receipt(soul.soulId,read.receipt.id)?.phase);i++)await tick();
 const receipt=edge.receipt(soul.soulId,read.receipt.id);assert.equal(receipt.phase,'completed');assert.ok(JSON.stringify(receipt.outcome).includes('Rain on the roof'));assert.ok(JSON.stringify(receipt.outcome).includes(soul.soulId));
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);assert.deepEqual(restored.get('poem').state,e().state);assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',text,state:e().state,read:receipt.outcome,hereBytes:{absent:strip(absent).length,distant100:strip(distant).length,nearby:JSON.stringify(near).length},stroke,interruption:edge.receipt(soul.soulId,cut.receipt.id).phase};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(`${process.env.SOUL_ACTIONS_OUT}/summary.json`,JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
