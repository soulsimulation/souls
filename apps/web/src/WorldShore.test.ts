import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hashOf} from '../../../packages/engine-contract/src/hash.ts';
import {connectedCommonsShoreFixture} from '../../../packages/engine-mars/src/connected-shore.ts';
import {EDEN_GROUND_EXTENSION_V1} from '../../../packages/engine-mars/src/eden-ground.ts';
// WorldGeometry reads the page path at import; a node test has none.
(globalThis as {location?:unknown}).location??={pathname:'/w/eden/',search:'',hash:''};
const {parseSceneInfo}=await import('./WorldGeometry.ts');

// The rules version a local Eden booted with APPLY_EDEN_EXPANSION_CHECKPOINT=1 publishes (#1518). Its shore
// metadata hash was on no list; its spatial projection was already the qualified east/north extension.
const CHECKPOINT_RULES='sim-mars/1+retained-shore/1+mars-engine/1+mars-assembly/3+activities/31+bodies/1+eg/1+crew-removal/1+commons/1+arrival-clearance/1+walk-block/1+souls-repair/1+cp/2+commons-kitchen/2+l/1+ss/1';
const spatial=(s:any)=>({bounds:s.bounds,levels:s.levels,surfaces:s.surfaces,obstacles:s.obstacles,links:s.links});
const connected=(await connectedCommonsShoreFixture()).renderScene();
const expanded=(await connectedCommonsShoreFixture(undefined,EDEN_GROUND_EXTENSION_V1)).renderScene();
const accepts=(raw:any)=>{const info=parseSceneInfo(structuredClone(raw));assert.equal(info.shore?.profile,'connected-commons-shore/1');return info;};
const refuses=(raw:any,why:string)=>assert.throws(()=>parseSceneInfo(raw),/Unsupported connected commons shoreline capture/,why);

test('the producer captures are the qualified connected and east/north scenes',()=>{
 assert.equal(hashOf(spatial(connected.scene)),'fb9116a3d8f05b27d4f5358625859176a33f7543d8087bb7b27b209ef6f5a7ba');
 assert.equal(hashOf(spatial(expanded.scene)),'903c58c5bce3079c0ce50d1f722eca1cc969cd8744f00d3d1c965c8e82a414e1');
 accepts(connected);accepts(expanded);
});

test('a new rules suffix or static hash does not stop the client (#1518 L1, L2)',()=>{
 const live=structuredClone(expanded) as any;
 live.shore.rulesVersion=CHECKPOINT_RULES;live.shore.physicalBase.staticHash='5c26a0b865994f7ea3823de6897678b215351d16c59c0d8007b441c136028354';
 assert.equal(hashOf(live.shore),'1e05625e6e3916458cc1e03416207f105ecd6a1f14b46efbd0dca0ca03106e11');
 const info=accepts(live);assert.ok(info.scene!.surfaces.some(s=>s.id==='eden-north-ground'));
 const plain=structuredClone(connected) as any;plain.shore.rulesVersion=CHECKPOINT_RULES.replace('+eg/1','');accepts(plain);
});

test('unsupported connected captures are refused with the named reason (#1518 L1-refused)',()=>{
 const cases:[string,any,(x:any)=>void][]=[
  ['terrain height',expanded,x=>{x.shore.terrain.heightMetres[3][20]+=.01;}],
  ['water bounds',expanded,x=>{x.shore.water.wetBoundsXZ[2]=-45;}],
  ['unknown campus',expanded,x=>{x.shore.physicalBase.campus='eden-commons-shore-elsewhere/1';}],
  ['expanded scene under the plain campus',expanded,x=>{x.shore.physicalBase.campus='eden-commons-shore/1';}],
  ['ground reaching the shore',expanded,x=>{const s=x.scene.surfaces.at(-1);s.obb.c[0]=-30;s.obb.half[0]=10;x.scene.bounds[0]=-62;}],
  ['raised extra surface',expanded,x=>{x.scene.surfaces.at(-1).y=.5;}],
  ['turned extra surface',expanded,x=>{x.scene.surfaces.at(-1).obb.yaw=.1;}],
  ['bounds wider than the grounds',expanded,x=>{x.scene.bounds[2]+=1;}],
  ['plain bounds widened',connected,x=>{x.scene.bounds[3]+=1;}],
  ['base obstacle changed',expanded,x=>{x.scene.obstacles[0].obb.c[0]+=.5;}],
  ['base surface removed',connected,x=>{x.scene.surfaces.shift();}],
 ];
 for(const [why,base,mutate] of cases){const raw=structuredClone(base);mutate(raw);refuses(raw,why);}
});
