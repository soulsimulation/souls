// Edge startup rules: the Little Martians worlds (old world + launcher arium) do not get the stair-traffic rules
// (occupiedLinkRoutingV1, concurrentLinkEgressV1, stairLandingClearanceV1); every other edge world keeps the full sequence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {Db} from './db.ts';
import {WorldHost} from './world.ts';
import {marsFactory,GREEN_FIELD_WORLD,LITTLE_MARTIANS_WORLD} from '@souls/engine-mars';
import {enableEdgeRuntimeRules,adoptBootRuntimePoliciesV1,LITTLE_MARTIANS_WORLD_KEYS} from './edge-runtime-rules.ts';

type Policy = {quietStallReleaseV1?:boolean;yieldTimeoutV1?:boolean;spreadV2?:boolean;routeReachV1?:boolean;occupiedLinkRoutingV1?:boolean;concurrentLinkEgressV1?:boolean;stairLandingClearanceV1?:boolean};
async function startup(worldKey:string,config:typeof GREEN_FIELD_WORLD){
 const db=new Db(':memory:'),host=new WorldHost(db,await marsFactory(config),'edge-rules',1e9,`${worldKey}-1`);
 try{
  host.boot();let done=false;const p=enableEdgeRuntimeRules(host,worldKey).finally(()=>{done=true;});
  while(!done){host.drainInputs();await setImmediate();}await p;
  const authors=(db.db.prepare("SELECT author FROM events WHERE world_id=? AND kind='rules' ORDER BY seq").all(host.worldId) as {author:string}[]).map(r=>r.author);
  const services=(host.engine as unknown as {rt:{services:Record<string,unknown>}}).rt.services;
  return {policy:(host.extra.runtimePolicy??{}) as Policy,authors,services};
 }finally{host.stop();db.close();}
}

test('Little Martians startup does not queue occupied-link routing, concurrent link egress or stair landing clearance',async()=>{
 assert.deepEqual([...LITTLE_MARTIANS_WORLD_KEYS],['littlemartians','little-martians-arium']);
 for(const [key,config] of [['littlemartians',LITTLE_MARTIANS_WORLD],['little-martians-arium',GREEN_FIELD_WORLD]] as const){
  const {policy,authors,services}=await startup(key,config);
  assert.equal(policy.quietStallReleaseV1,true,key);assert.equal(policy.yieldTimeoutV1,true,key);assert.equal(policy.spreadV2,true,key);
  assert.equal(policy.routeReachV1,true,key+': route-reach/1 (#872) is on every edge world');
  assert.equal(policy.occupiedLinkRoutingV1,undefined,key);assert.equal(policy.concurrentLinkEgressV1,undefined,key);assert.equal(policy.stairLandingClearanceV1,undefined,key);
  assert.ok(!authors.includes('operator:occupied-link-routing')&&!authors.includes('operator:concurrent-link-egress')&&!authors.includes('operator:stair-landing-clearance'),key+': '+authors.join(','));
  assert.notEqual(services.occupiedLinkRoutingV1,true,key);assert.notEqual(services.concurrentLinkEgressV1,true,key);assert.notEqual(services.stairLandingClearanceV1,true,key);
 }
});

test('a qualifying non-Little-Martians edge world activates the three stair-traffic rules after the existing three',async()=>{
 for(const key of ['eden-2026','my-mars-college-2026-3','godmode-lab']){
  const {policy,authors,services}=await startup(key,GREEN_FIELD_WORLD);
  assert.equal(policy.occupiedLinkRoutingV1,true,key);assert.equal(policy.concurrentLinkEgressV1,true,key);assert.equal(policy.stairLandingClearanceV1,true,key);
  assert.deepEqual(authors.filter(a=>a.startsWith('operator:')).slice(-3),['operator:occupied-link-routing','operator:concurrent-link-egress','operator:stair-landing-clearance'],key);
  assert.equal(services.occupiedLinkRoutingV1,true,key);assert.equal(services.concurrentLinkEgressV1,true,key);assert.equal(services.stairLandingClearanceV1,true,key);
  assert.equal(policy.routeReachV1,true,key);
 }
});

test('main.ts activates edge startup rules through the shared helper with the world key',()=>{
 const main=readFileSync(new URL('./main.ts',import.meta.url),'utf8');
 // #1332: through the boot chain, which applies the edge rules after the courtesy event and before body-step-guard/1
 assert.match(main,/if \(host\.engine\.configureRuntimePolicy\) void adoptBootRuntimePoliciesV1\(host, \{ after: courtesy, edge: !!edge, worldKey: config\.worldKey \}\)/);
 assert.match(readFileSync(new URL('./edge-runtime-rules.ts',import.meta.url),'utf8'),/if \(opts\.edge\) await enableEdgeRuntimeRules\(host, opts\.worldKey\)/);
 assert.doesNotMatch(main,/enableOccupiedLinkRoutingV1|enableConcurrentLinkEgressV1|enableStairLandingClearanceV1/);
});

test('#2133 every world adopts stall-release-support/1 at boot after stand-height/2, then #2294 held-activity/1 last, and the engine has both on',async()=>{
 const db=new Db(':memory:'),host=new WorldHost(db,await marsFactory(GREEN_FIELD_WORLD),'edge-rules',1e9,'boot-1');
 try{
  host.boot();let done=false;const p=adoptBootRuntimePoliciesV1(host,{edge:false,worldKey:'boot'}).finally(()=>{done=true;});
  while(!done){host.drainInputs();await setImmediate();}await p;
  const rules=(db.db.prepare("SELECT payload FROM events WHERE world_id=? AND kind='rules' ORDER BY seq").all(host.worldId) as {payload:string}[]).map(r=>JSON.parse(r.payload).runtimePolicy??{});
  const first=rules.findIndex(r=>r.stallReleaseSupportV1===true);
  assert.equal(first,rules.length-2,'adopted by the rules event before the last');assert.equal(rules[first].standHeightV2,true,'after stand-height/2');
  assert.equal(rules.findIndex(r=>r.heldActivitiesV1===true),rules.length-1,'held-activity/1 by the last rules event');assert.equal(rules[rules.length-1].stallReleaseSupportV1,true,'after stall-release-support/1');
  const cfg=(host.engine.snapshot() as unknown as {cfg:{stallReleaseSupportV1?:boolean;heldActivitiesV1?:boolean}}).cfg;
  assert.equal(cfg.stallReleaseSupportV1,true);assert.equal(cfg.heldActivitiesV1,true);
 }finally{host.stop();db.close();}
});
