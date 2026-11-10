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
import {handActuatorFrame} from '../../mars/viewer/engine/social/hand-actuator.ts';
import {coreLibrary,WorldModel} from '../../packages/world-compiler/src/index.ts';

test('written intention becomes spent only at native fire contact and remains spent after extinction',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'artist');const row=await accept(f.host,f.souls.create('dev:artist',{name:'Ana',description:'A quiet paper ritual'}));soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length,absent=await here();
 ok(god.act({ops:[{op:'define',def:coreLibrary().get('core-intention-burner@1')},...Array.from({length:100},(_,i)=>({op:'place',def:'core/intention-burner@1',name:'far-'+i,p:[120+i%10*2,120+Math.floor(i/10)*2]}))]}));await tick(45);const far=await here();assert.equal(bytes(far),bytes(absent),'100 distant local stands add zero nearby bytes');
 ok(god.act({ops:[{op:'place',def:'core/intention-burner@1',name:'ritual',p:[2,2],r:Math.PI},{op:'place',def:'core/intention-burner@1',name:'private-ritual',p:[-3,2],access:'private',state:{text:'Private words'}}]}));await tick(45);
 const entity=()=>[...god.model.entities.values()].find(e=>e.name==='ritual'),id=entity().id,state=()=>entity().state??{},body=()=>f.host.engine.world.entities[soul.entityId];
 const act=(a,params={})=>accept(f.host,edge.act(soul,{capability:'object:'+id+':'+a,params}));
 let transition,early=false;const finish=async(r,watch=false)=>{ok(r);for(let i=0;i<1800;i++){const receipt=edge.receipt(soul.soulId,r.receipt.id),m=body().human?.handActuator;if(watch&&state().spent===true&&m?.target===id){const frame=handActuatorFrame(m,(f.host.engine.world.tick-m.startTick)*f.host.engine.dt);if(!frame.contact)early=true;transition??={contact:frame.contact,commitAt:frame.commitAt};}if(['completed','failed','replaced'].includes(receipt.phase)){assert.equal(receipt.phase,'completed',JSON.stringify(receipt));return receipt;}await tick();}assert.fail('finite action did not end');};
 await here();const blank=await act('light');assert.equal(blank.accepted,false,'blank paper cannot be lit');
 const priv=[...god.model.entities.values()].find(e=>e.name==='private-ritual');for(const a of ['write','light']){const denied=await accept(f.host,edge.act(soul,{capability:'object:'+priv.id+':'+a,params:a==='write'?{text:'Changed'}:{}}));assert.equal(denied.accepted,false);assert.match(JSON.stringify(denied),/private|access|owner/);}
 const words='Let old worries rest; make room for wonder.';const writing=ok(await act('write',{text:words}));assert.equal(state().text,'','no admission-time writing');await finish(writing);assert.equal(state().text,words);assert.equal(state().textBy,soul.soulId);
 const writtenRead=await finish(await accept(f.host,edge.act(soul,{capability:'read:'+id,params:{}})));assert.ok(JSON.stringify(writtenRead.outcome).includes(words));
 const cut=ok(await act('light'));assert.equal(state().spent,false);await finish(await accept(f.host,edge.act(soul,{capability:'stand:here',params:{}})));await tick(40);assert.notEqual(edge.receipt(soul.soulId,cut.receipt.id).phase,'completed');assert.equal(state().spent,false);assert.equal(state().on,false);assert.equal(state().text,words);
 const burn=ok(await act('light'));assert.equal(state().spent,false,'admission does not burn paper');await finish(burn,true);assert.equal(early,false);assert.equal(transition?.contact,true);assert.equal(state().spent,true);assert.equal(state().on,true);assert.equal(state().textBy,'');assert.ok(!state().text.includes(words));
 const off=await finish(await act('put-out'));assert.equal(state().on,false);assert.equal(state().spent,true);assert.match(state().text,/spent.*fire is out/i);
 for(const a of ['write','light']){const r=await act(a,a==='write'?{text:'New words'}:{});assert.equal(r.accepted,false,'spent paper cannot '+a);}assert.equal(state().on,false);assert.equal(state().spent,true);
 const finalRead=await finish(await accept(f.host,edge.act(soul,{capability:'read:'+id,params:{}})));assert.ok(JSON.stringify(finalRead.outcome).includes('The fire is out.'));
 const saved=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);assert.deepEqual(saved.entities.get(id),JSON.parse(JSON.stringify(entity())));assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',wordsBeforeBurn:words,finalStatus:state().text,spent:state().spent,on:state().on,transition,contextBytes:{absent:bytes(absent),distant100:bytes(far)},checks:['public definition','own native written/read words','no admission effects','precontact interruption preserves paper and words','native contact commits spent material','putout retains spent status','private/blank/spent refusal','persistent identity/status','zero native violations']};if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/intention.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
