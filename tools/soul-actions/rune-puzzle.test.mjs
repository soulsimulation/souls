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

const cells=['northwest','north','northeast','southwest','south','southeast'];
const expected=[[0,1,3],[0,1,2,4],[1,2,5],[0,3,4],[1,3,4,5],[2,4,5]];
const start=[true,true,true,false,true,false];
test('rune puzzle declares six independent cross effects, readable rules and a guarded persistent win/reset',()=>{
 const d=coreLibrary().get('core-rune-puzzle@1');assert.ok(d);assert.deepEqual(cells.map(k=>d.state[k].default),start);
 for(let i=0;i<6;i++){const a=d.actions.find(a=>a.name==='wave-'+cells[i]);assert.deepEqual(a.then,expected[i].map(j=>({op:'toggle',field:cells[j]})));}
 assert.ok(d.state.rules.default.includes('orthogonal'));assert.equal(d.components.carryable,undefined);
});
test('actual native admitted gestures solve/reset the world puzzle, preserve partial state and obey access',{timeout:60000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;
 const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
 installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 await tick(5);await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Solving a rune puzzle'}));soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
 const [x,,z]=f.host.engine.world.entities[soul.entityId].pose.p,here=async()=>await(await app.request('/v1/edge/here?include=doHere')).json(),bytes=h=>JSON.stringify(h.here).length;
 const absent=await here();ok(god.act({ops:Array.from({length:100},(_,i)=>({op:'place',def:'core/rune-puzzle@1',name:'distant-'+i,p:[x+120+i%10*3,z+120+Math.floor(i/10)*3]}))}));await tick(50);const distant=await here();assert.equal(bytes(distant),bytes(absent));assert.ok(!/distant-/.test(JSON.stringify(distant.here)));
 ok(god.act({ops:[{op:'place',def:'core/rune-puzzle@1',name:'puzzle',p:[x+1.3,z],r:Math.PI},{op:'place',def:'core/rune-puzzle@1',name:'private-puzzle',p:[x-3,z],access:'private'}]}));await tick(50);
 const entity=n=>[...god.model.entities.values()].find(e=>e.name===n),id=entity('puzzle').id,mask=()=>cells.map(k=>entity('puzzle').state[k]);
 const act=(a,target=id)=>accept(f.host,edge.act(soul,{capability:'object:'+target+':'+a,params:{}}));
 const finish=async r=>{ok(r);for(let n=0;n<600;n++){const end=edge.receipt(soul.soulId,r.receipt.id);if(['completed','failed','replaced'].includes(end.phase))return end;await tick();}assert.fail('gesture did not end');};
 const done=async a=>{const r=await finish(await act(a));assert.equal(r.phase,'completed',JSON.stringify(r));return r;};
 assert.deepEqual(mask(),start);assert.equal((await act('claim-solved')).accepted,false);assert.equal((await act('wave-north',entity('private-puzzle').id)).accepted,false);
 for(let i=0;i<6;i++){await done('reset');await done('wave-'+cells[i]);assert.deepEqual(mask(),start.map((v,j)=>expected[i].includes(j)?!v:v),cells[i]);}
 await done('reset');const admitted=ok(await act('wave-northwest'));await tick(2);assert.notEqual(edge.receipt(soul.soulId,admitted.receipt.id).phase,'completed');const partial=mask();assert.deepEqual(partial,start.map((v,j)=>expected[0].includes(j)?!v:v));
 await finish(ok(await accept(f.host,edge.act(soul,{capability:'stand:here',params:{}}))));assert.deepEqual(mask(),partial,'admitted generic effect remains after stopping wave');
 const partialRestored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);assert.deepEqual(partialRestored.entities.get(id).state,JSON.parse(JSON.stringify(entity('puzzle').state)));
 await done('reset');for(const k of ['northwest','northeast','south'])await done('wave-'+k);assert.deepEqual(mask(),Array(6).fill(false));await done('claim-solved');assert.equal(entity('puzzle').state.solved,true);assert.equal(entity('puzzle').state.wins,1);
 assert.equal((await act('claim-solved')).accepted,false);assert.equal((await act('wave-north')).accepted,false);await done('reset');assert.deepEqual(mask(),start);assert.equal(entity('puzzle').state.wins,1);
 for(const k of ['south','northeast','northwest'])await done('wave-'+k);await done('claim-solved');assert.equal(entity('puzzle').state.wins,2);
 const inspection=await(await app.request('/v1/edge/inspect/'+id+'?all=1')).json();assert.ok(JSON.stringify(inspection).includes('orthogonal'));assert.ok(JSON.stringify(inspection).includes('wins'));assert.equal(inspection.inspect.state.wins,2,'current inspect must expose current completed rounds');for(const k of cells)assert.equal(inspection.inspect.state[k],false,'current inspect must expose current solved grid');
 const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);assert.deepEqual(restored.entities.get(id),JSON.parse(JSON.stringify(entity('puzzle'))));assert.deepEqual(f.host.engine.runtime.violations,[]);
 const report={status:'pass',contextBytes:{absent:bytes(absent),distant100:bytes(distant),nearby:bytes(await here())},wins:2,initial:start,checks:['all six selected-cell+orthogonal effects','guarded all-dark recognition','duplicate solved claim refused','reset exact pattern retains wins','second solution records second round','admission timing and stop retains effect','private access refused','partial and solved model snapshot restoration','readable actual rules/state','zero native violations']};
 if(process.env.SOUL_ACTIONS_OUT){mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});writeFileSync(process.env.SOUL_ACTIONS_OUT+'/rune.json',JSON.stringify(report,null,2));}console.log(JSON.stringify(report));
});
