// #2282: a door thing set in a building's bare doorway is the building's door. The Eden classroom (core/hall@2, its
// outside doors marked leaf: false) with a core/door@2 in each doorway, swinging outward: open, a Soul walks in and out
// with no hand; closed, the door blocks the doorway, so the walk goes through it by hand and closes it behind.
// Deterministic native run on the real server stack (ledger, god model, engine bridge).
import test from 'node:test';import assert from 'node:assert/strict';import {setImmediate} from 'node:timers/promises';import {readFileSync} from 'node:fs';import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture,invite,accept,factory} from '../../apps/server/test/native-owner-fixture.ts';import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';import {GodMode} from '../../apps/server/src/god/god.ts';import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

/** The template's own classroom ops: the hall and the doors set in its doorways, moved to the origin. */
function classroomOps(){
 const tpl=JSON.parse(readFileSync(new URL('../../worlds/templates/eden-2026.json',import.meta.url),'utf8')),ops=[];
 const walk=o=>{if(Array.isArray(o))o.forEach(walk);else if(o&&typeof o==='object'){if(o.op==='place'&&/^eden-classroom-1(-door-[sn])?$/.test(o.name??''))ops.push(structuredClone(o));else Object.values(o).forEach(walk);}};walk(tpl);
 const hall=ops.find(o=>o.name==='eden-classroom-1'),at=hall.p;for(const o of ops)o.p=[o.p[0]-at[0],o.p[1]-at[1]];return ops;
}

test('a door thing in a building doorway: passable open, blocks closed (walked through by hand)',{timeout:240000},async t=>{
 const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false}),app=new Hono();let soul;const comms=mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,ledger:edge,soul:()=>soul});t.after(()=>{comms.close();f.host.stop();f.db.close();});
 const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
 const tick=async(n=5)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};const ok=r=>{assert.equal(r.accepted,true,JSON.stringify(r));return r;};
 const W=new Proxy({},{get:(_,k)=>f.host.engine.world[k]});
 const ops=classroomOps();assert.deepEqual(ops.map(o=>o.name).sort(),['eden-classroom-1','eden-classroom-1-door-n','eden-classroom-1-door-s']);
 const hall=ops.find(o=>o.name==='eden-classroom-1');assert.equal(hall.def,'core/hall@2');assert.ok(hall.params.plan.floors[0].exterior.every(e=>e.leaf===false),'bare doorways');
 // the south door: the hall's south wall is at z 9.39 (19 m deep, 0.22 m walls); outside is +z. Benches inside, a lamp outside.
 const z=9.39;ok(god.act({ops:[...ops,{op:'place',def:'core/bench@1',name:'inside-bench',p:[1.5,z-4]},{op:'place',def:'core/floor-lamp@2',name:'outside-lamp',p:[2.5,z+4]}]}));await tick(45);
 const door=()=>god.model.get('eden-classroom-1-door-s');assert.equal(door().state.open,false,'closed by default');assert.equal(god.model.get('eden-classroom-1-door-n').state.open,false);
 await invite(f,'ana');const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Classroom door walk check'}));const ana={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick();
 const finish=async(s,r,limit=1600)=>{for(let n=0;n<limit;n++){const ph=edge.receipt(s.soulId,r.receipt.id);if(['failed','completed','replaced'].includes(ph?.phase))return ph;await tick(1);}return edge.receipt(s.soulId,r.receipt.id);};
 const walk=async cap=>{const r=ok(await accept(f.host,edge.act(ana,{capability:cap})));const e=await finish(ana,r);assert.equal(e.phase,'completed',JSON.stringify(e));return r;};
 const side=()=>W.entities[ana.entityId].pose.p[2]>z?'outside':'inside';
 // start outside the classroom, by the lamp
 await walk('walk:outside-lamp');assert.equal(side(),'outside');
 // 1. closed: the door blocks the doorway, so the walk in goes through it by hand, and closes it behind
 const r1=await walk('walk:inside-bench');assert.match(r1.receipt.reason??'',/Through eden-classroom-1-door-s/,'a closed door blocks: the walk opens it by hand');assert.equal(side(),'inside');assert.equal(door().state.open,false,'closed behind');
 const r2=await walk('walk:outside-lamp');assert.match(r2.receipt.reason??'',/Through eden-classroom-1-door-s/);assert.equal(side(),'outside');assert.equal(door().state.open,false);
 // 2. open: the doorway is passable, a plain walk with no hand, and the door is left open
 ok(god.act({ops:[{op:'set',id:'eden-classroom-1-door-s',state:{open:true}}]}));await tick(20);
 const r3=await walk('walk:inside-bench');assert.doesNotMatch(r3.receipt.reason??'',/Through eden-classroom-1-door-s/,'an open door is passable');assert.equal(side(),'inside');assert.equal(door().state.open,true,'found open, left open');
 const r4=await walk('walk:outside-lamp');assert.doesNotMatch(r4.receipt.reason??'',/Through eden-classroom-1-door-s/);assert.equal(side(),'outside');
 assert.deepEqual(f.host.engine.runtime.violations,[]);
});
