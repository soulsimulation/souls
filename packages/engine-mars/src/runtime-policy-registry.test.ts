// #1363: runtime-policy keys come from one registry, so a physical-binding snapshot reader cannot miss a new flag.
import test from 'node:test';
import assert from 'node:assert/strict';
import type {Engine,EngineFactory} from '@souls/engine-contract';
import {marsFactory,MarsEngine,RUNTIME_POLICY_FLAGS,RUNTIME_POLICY_KEYS,physicalBindingCfgV1,type MarsWorldConfig} from './engine.ts';
import {retainedCommonsShoreFactory} from './retained-shore-engine.ts';
import {marsCampExpansionFactory} from './camp-expansion-engine.ts';
import {connectedCommonsShoreFactory} from './connected-shore-engine.ts';
import {connectedCommonsBoatFactory} from './connected-boat-engine.ts';
import {nativeCampDrinkFactory} from './drink-engine.ts';

const KEYS=new Set<string>(RUNTIME_POLICY_KEYS);
const cfgOf=(e:Engine)=>structuredClone((e.snapshot() as unknown as {cfg:Record<string,unknown>}).cfg);
const changed=(a:Record<string,unknown>,b:Record<string,unknown>)=>[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));
/** Every registry key on, through the engine's own calls (as the logged rules facts apply them). */
function allOn(e:Engine){
  const m=e as MarsEngine;
  m.configureRuntimePolicy({sleepBlockTicks:1200,quietSeatCourtesy:true,...Object.fromEntries(RUNTIME_POLICY_FLAGS.map(k=>[k,true]))});
  m.configureClock({origin:0,dayTicks:72000});m.enableGroundReclaimV1();
}

test('A2 configureRuntimePolicy reads and sets only registry keys, and every registry flag is one it reads',async()=>{
  const f=await marsFactory(),e=f.create(f.genesis('registry')) as MarsEngine,before=cfgOf(e),read=new Set<string>();
  // every field of the policy reads as on: a flag handled by the method but missing from the registry is seen here
  const policy=new Proxy({},{get:(_t,k)=>{if(typeof k!=='string')return undefined;read.add(k);return k==='sleepBlockTicks'?1200:true;}});
  e.configureRuntimePolicy(policy as never);
  const after=cfgOf(e);
  assert.deepEqual([...read].filter(k=>!KEYS.has(k)),[],'configureRuntimePolicy reads a key the registry lacks: add it to RUNTIME_POLICY_FLAGS');
  assert.deepEqual(changed(before,after).filter(k=>!KEYS.has(k)),[],'configureRuntimePolicy sets a cfg key the registry lacks');
  assert.deepEqual(RUNTIME_POLICY_FLAGS.filter(k=>!read.has(k)),[],'a registry flag configureRuntimePolicy never reads');
  for(const k of RUNTIME_POLICY_FLAGS)assert.equal(after[k],true,k);
  for(const [name,apply] of [['configureClock',()=>e.configureClock({origin:5,dayTicks:1000})],['enableGroundReclaimV1',()=>e.enableGroundReclaimV1()]] as const){
    const was=cfgOf(e);apply();const moved=changed(was,cfgOf(e));assert.ok(moved.length,name);assert.deepEqual(moved.filter(k=>!KEYS.has(k)),[],name);
  }
  // the binding comparison drops exactly the registry and keeps the physical config
  const stripped=physicalBindingCfgV1(cfgOf(e) as MarsWorldConfig);for(const k of KEYS)assert.equal(k in stripped,false,k);
  assert.equal(stripped.scene,after.scene);
});

const campCfg:MarsWorldConfig={scene:'eden-camp',safeArrivalV1:true,safeCrewRemoval:true,arrival:[-3,18],arrivalPlace:'arrival',reference:[-1,17],grounds:{id:'grounds',name:'Camp grounds'}};
const readers:[string,()=>Promise<{f:EngineFactory;e:Engine}>][]=[
  ['retained shore',async()=>{
    const f=await retainedCommonsShoreFactory(),e=f.create(f.genesis('registry-retained'));
    const p=e.previewCommonsProvisionsV1!();assert.ok(p.ok);e.adoptCommonsProvisionsV1!(p.transition);
    const k=e.previewCommonsKitchenV1!();assert.ok(k.ok);e.adoptCommonsKitchenV1!(k.transition);
    const q=e.previewRetainedCommonsShoreV1!();assert.ok(q.ok,JSON.stringify(q));e.adoptRetainedCommonsShoreV1!(q.transition);return {f,e};
  }],
  ['camp expansion',async()=>{
    const f=await marsCampExpansionFactory(campCfg),e=f.create(f.genesis('registry-camp'));
    for(let i=0;i<100&&!e.previewCampExpansionV1!().ok;i++)e.step();
    const p=e.previewCampExpansionV1!();assert.ok(p.ok,JSON.stringify(p));e.adoptCampExpansionV1!(p.transition);return {f,e};
  }],
  ['connected shore',async()=>{const f=await connectedCommonsShoreFactory();return {f,e:f.create(f.genesis('registry-shore'))};}],
  ['connected boat',async()=>{const f=await connectedCommonsBoatFactory();return {f,e:f.create(f.genesis('registry-boat'))};}],
  ['drink',async()=>{const f=await nativeCampDrinkFactory();return {f,e:f.create(f.genesis('registry-drink'))};}],
];

for(const [name,make] of readers)test(`A3 ${name}: a bound snapshot with every registry key on restores with an equal state hash`,async()=>{
  const {f,e}=await make();
  for(let i=0;i<10;i++)e.step();
  assert.ok('physicalBinding' in (e.snapshot() as object),`${name} snapshot is physically bound`);
  allOn(e);for(let i=0;i<10;i++)e.step();
  const snap=e.snapshot(),on=(snap as unknown as {cfg:Record<string,unknown>}).cfg;
  for(const k of RUNTIME_POLICY_FLAGS)assert.equal(on[k],true,`${name} ${k}`);
  const r=f.restore(snap);assert.equal(r.stateHash(),e.stateHash(),name);
  for(let i=0;i<20;i++){e.step();r.step();}assert.equal(r.stateHash(),e.stateHash(),name);
  // a physical config that really differs is still refused
  const bad=structuredClone(snap) as unknown as {cfg:Record<string,unknown>};bad.cfg.disassemblyV1=true;
  assert.throws(()=>f.restore(bad as never),/snapshot-(binding|policy)/,name);
});
