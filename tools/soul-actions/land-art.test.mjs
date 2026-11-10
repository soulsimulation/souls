import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fixture,invite,accept,factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {coreLibrary,WorldModel} from '../../packages/world-compiler/src/index.ts';
import {TakeRecorder} from '../../mars/viewer/engine/take/recorder.ts';

const pieces=['smooth-stone','flat-stone','driftwood-piece'];

test('land-art materials are small independent recorded items, without a pattern or action of their own',()=>{
  const library=coreLibrary();
  for(const name of pieces){
    const def=library.get(`core-${name}@1`);
    assert.ok(def);assert.ok(def.tags.includes('recorded-item'));
    assert.equal(def.components.carryable.grips,1);
    assert.ok(def.components.carryable.mass<1);
    assert.ok(Math.max(...def.size.box)<.3);
    assert.equal(def.actions.length,0);
    assert.equal(def.slots.length,0);
  }
});

test('a Soul picks up, carries, places and rearranges separate pieces with native support and persistent positions',{timeout:60000},async t=>{
  const f=fixture(':memory:',factory,{durableClockV1:true});f.brain.quiesce();
  const edge=new EdgeLedger(f.host,f.db,undefined,{ambient:false});
  const god=new GodMode(f.db,{worldId:f.host.worldId,ownerId:'dev:admin',tick:()=>f.host.engine.world.tick,emit(){}});
  installEngineBridge({host:f.host,god,edge,log(){},worldLore:false,worldClock:false});
  t.after(()=>{f.host.stop();f.db.close();});
  const tick=async(n=1)=>{for(let i=0;i<n;i++){f.host.tickOnce();await setImmediate();f.host.drainInputs();}};
  await tick(5);await invite(f,'ana');
  const row=await accept(f.host,f.souls.create('dev:ana',{name:'Ana',description:'Arranging natural materials'}));
  const soul={soulId:row.id,entityId:row.entity_id,name:row.name,owner:row.owner};await tick(5);
  const body=()=>f.host.engine.world.entities[soul.entityId], [x,,z]=body().pose.p;
  const placed=god.act({ops:[
    ...pieces.map((name,i)=>({op:'place',def:`core/${name}@1`,name,p:[x+1.5,z+(i-1)*.6]})),
    {op:'place',def:'core/smooth-stone@1',name:'private-stone',p:[x-1.5,z],access:'private'},
    ...[[5,-1],[5,1],[8,0]].map(([dx,dz],i)=>({op:'place',def:'core/zone@1',name:`clearing-${i}`,shape:{area:[[x+dx-.3,z+dz-.3],[x+dx+.3,z+dz-.3],[x+dx+.3,z+dz+.3],[x+dx-.3,z+dz+.3]]}})),
  ]});assert.equal(placed.accepted,true,JSON.stringify(placed));await tick(50);
  const id=name=>god.model.get(name).id;
  const run=async capability=>{
    const asked=await accept(f.host,edge.act(soul,{capability}));assert.equal(asked.accepted,true,JSON.stringify(asked));
    for(let n=0;n<1600;n++){
      const receipt=edge.receipt(soul.soulId,asked.receipt.id);
      if(['completed','failed','replaced'].includes(receipt.phase)){assert.equal(receipt.phase,'completed',JSON.stringify(receipt));return receipt;}
      await tick();
    }assert.fail(`finite action did not finish: ${capability}`);
  };
  const recorder=new TakeRecorder(f.host.engine.rt,{rulesVersion:'land-art-proof'});
  const start=god.model.snapshot(),records=[];
  const privateItem=id('private-stone'),privateBefore=structuredClone(f.host.engine.world.entities[privateItem].pose);
  const privateOffer=edge.capabilities(soul).find(c=>c.id===`pick-up:${privateItem}`);
  assert.equal(privateOffer?.available,false);assert.equal(privateOffer.blocked.code,'object.private');
  const refused=await accept(f.host,edge.act(soul,{capability:`pick-up:${privateItem}`}));assert.equal(refused.accepted,false);
  assert.deepEqual(f.host.engine.world.entities[privateItem].pose,privateBefore,'ownership refusal leaves the nearby stone in place');
  for(let i=0;i<pieces.length;i++){
    const name=pieces[i],item=id(name),before=[...f.host.engine.world.entities[item].pose.p];
    assert.ok(edge.capabilities(soul).find(c=>c.id===`pick-up:${item}`)?.available);
    const pickup=await run(`pick-up:${item}`);
    assert.equal(f.host.engine.world.entities[item].support.kind,'in-hand');
    assert.equal(f.host.engine.world.entities[item].support.by,soul.entityId);
    assert.equal(edge.together.observe(soul).holding.id,item);
    if(i===0){
      const other=id(pieces[1]);assert.ok(!edge.capabilities(soul).some(c=>c.id===`pick-up:${other}`&&c.available));
      const full=await accept(f.host,edge.act(soul,{capability:`pick-up:${other}`}));assert.equal(full.accepted,false);
      assert.equal(f.host.engine.world.entities[item].support.by,soul.entityId,'refused second pickup preserves the held piece');
    }
    if(i===0){
      const walk=await accept(f.host,edge.act(soul,{capability:'walk:clearing-0'}));assert.equal(walk.accepted,true);
      let arrivedAlongRoute=false;
      for(let n=0;n<500;n++){if(body().pose.p[0]>x+2.5){arrivedAlongRoute=true;break;}await tick();}
      assert.ok(arrivedAlongRoute,'the carried stone reaches a chosen point along the route');
      await run('stop:current');await tick(5);
      const stopped=[...body().pose.p];await tick(5);
      assert.deepEqual(body().pose.p,stopped,'stopping chooses a real intermediate location');
      assert.ok(stopped[0]<x+4,'placement need not wait for the named destination');
    }else await run(`walk:clearing-${i%2}`);
    assert.equal(f.host.engine.world.entities[item].support.by,soul.entityId,'walking keeps native custody');
    const put=await run('put-down:here');await tick(25);
    const end=f.host.engine.world.entities[item];
    assert.equal(end.support.kind,'ground');assert.equal(edge.together.observe(soul).holding,null);
    assert.ok(Math.hypot(end.pose.p[0]-before[0],end.pose.p[2]-before[2])>1,'the piece really moved');
    assert.ok(put.outcome.changed.some(c=>c.id===item&&c.kind==='item-placed'));
    records.push({name,pickup,put,firstPosition:[...end.pose.p]});
  }
  const stone=id(pieces[0]),first=[...f.host.engine.world.entities[stone].pose.p];
  await run(`pick-up:${stone}`);await run('walk:clearing-2');await run('put-down:here');await tick(25);
  assert.ok(Math.hypot(f.host.engine.world.entities[stone].pose.p[0]-first[0],f.host.engine.world.entities[stone].pose.p[2]-first[2])>1,'the same stone was rearranged');
  const restored=WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())),undefined,god.model.library);
  for(const name of pieces){
    const actual=f.host.engine.world.entities[id(name)],saved=god.model.worldPose(god.model.get(name)),reloaded=restored.worldPose(restored.get(name));
    assert.ok(Math.hypot(saved.x-actual.pose.p[0],saved.z-actual.pose.p[2])<.001,'model write-back matches native position');
    assert.deepEqual(reloaded,saved,'save/reload preserves the composition');
    assert.equal(actual.support.kind,'ground');
  }
  assert.deepEqual(f.host.engine.world.entities[privateItem].pose,privateBefore,'rearranging public pieces never moved the private stone');
  assert.deepEqual(f.host.engine.runtime.violations,[]);
  if(process.env.SOUL_ACTIONS_OUT){
    mkdirSync(process.env.SOUL_ACTIONS_OUT,{recursive:true});
    writeFileSync(`${process.env.SOUL_ACTIONS_OUT}/land-art.json`,JSON.stringify({start,records,final:god.model.snapshot(),take:recorder.finish()},null,2));
  }else recorder.finish();
});
