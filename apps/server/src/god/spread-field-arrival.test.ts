// #467 on a real fake-mind world: four Souls in a pavilion each `walk:field` in turn. With spread-field/1 their receipts all
// complete, their goals stand at least 1 m apart (3 m while the field has room), and nobody who arrived is moved by a later one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {fixture,factory,invite,accept} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {GodMode} from './god.ts';
import {installEngineBridge} from './engine-bridge.ts';
import {GroundHost} from './ground-host.ts';
import {coreRef} from '@souls/world-compiler';

test('#467 A1/A2: four walk:field returns get spaced goals, completed receipts, and displace nobody', {timeout:300000}, async t=>{
 const w=fixture(':memory:',factory,{durableClockV1:true});w.brain.quiesce();
 const god=new GodMode(w.db,{worldId:w.host.worldId,ownerId:'owner',tick:()=>w.host.engine.world.tick,emit(){}});
 new GroundHost(w.db,w.host,god);
 const edge=new EdgeLedger(w.host,w.db);const bridge=installEngineBridge({host:w.host,god,edge,log(){},worldClock:false,worldLore:false});
 t.after(()=>{w.brain.quiesce();w.host.stop();edge.comms?.close();w.db.close();});
 const settle=async(n=3)=>{for(let i=0;i<n;i++){w.host.tickOnce();await setImmediate();w.host.drainInputs();}};
 await settle();
 // one event after another: each copies the policy before it (edge-runtime-rules.ts)
 await accept(w.host,Promise.resolve(w.host.enableSpreadV2()));await settle();
 await accept(w.host,Promise.resolve(w.host.enableSpreadFieldV1()));await settle();
 assert.equal((w.host.extra.runtimePolicy as {spreadV2?:boolean}).spreadV2,true,'spreadV2 kept');
 assert.equal((w.host.extra.runtimePolicy as {spreadFieldV1?:boolean}).spreadFieldV1,true);
 const placed=god.act({ops:[{op:'place',def:coreRef('pavilion'),name:'pavilion',p:[9,0,-5],params:{w:6,d:4}}]});assert.equal(placed.accepted,true,JSON.stringify(placed));await settle();
 const souls:{soulId:string;entityId:string;name:string;owner:string}[]=[];
 for(const [i,name] of ['Ada','Bo','Cy','Di'].entries()){
  await invite(w,`guest-${i}`);const row=await accept(w.host,w.souls.create(`dev:guest-${i}`,{name,description:'A field-return regression guest'})) as {id:string;entity_id:string;name:string;owner:string};
  const soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};souls.push(soul);await settle();
  await accept(w.host,w.host.enqueue('edge-relocate','test:pavilion',{...soul,to:[7.6+i*0.9,-5],why:'start inside the pavilion, off the field'}));await settle();
 }
 bridge.perceive.sync(true);edge.map();
 const pos=(s:{entityId:string})=>{const p=(w.host.engine.world.entities[s.entityId] as unknown as {pose:{p:number[]}}).pose.p;return [p[0],p[2]] as [number,number];};
 const goals:[number,number][]=[],moved:string[]=[];
 for(const soul of souls){
  const before=souls.slice(0,goals.length).map(pos);
  const r=await accept(w.host,Promise.resolve(edge.act(soul,{capability:'walk:field'}))) as {accepted:boolean;receipt:{id:string}};assert.equal(r.accepted,true,JSON.stringify(r));
  let phase:string|undefined;
  for(let i=0;i<2400;i++){w.host.tickOnce();if(i%20===0){await setImmediate();w.host.drainInputs();}phase=edge.receipt(soul.soulId,r.receipt.id)?.phase;if(phase==='completed'||phase==='failed')break;}
  assert.equal(phase,'completed',`${soul.name}'s walk receipt completes before it could report the field (A2)`);
  goals.push(pos(soul));
  souls.slice(0,before.length).forEach((o,k)=>{const now=pos(o);if(Math.hypot(now[0]-before[k][0],now[1]-before[k][1])>0.05)moved.push(`${o.name} moved while ${soul.name} arrived`);});
 }
 let min=Infinity;for(let i=0;i<goals.length;i++)for(let j=i+1;j<goals.length;j++)min=Math.min(min,Math.hypot(goals[i][0]-goals[j][0],goals[i][1]-goals[j][1]));
 assert.ok(min>=1,`goals ${JSON.stringify(goals)}, closest ${min.toFixed(2)} m`);
 assert.deepEqual(moved,[]);
 t.diagnostic(`goals ${JSON.stringify(goals)}, closest ${min.toFixed(2)} m`);
});
