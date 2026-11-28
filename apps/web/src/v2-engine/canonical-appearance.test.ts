import {test} from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadCanonicalAppearance} from './canonical-appearance.ts';
import {CreatorKinds,setHeldKinds} from './creator-kinds.ts';
import {WorldModel,coreLibrary,defSchema,hashOf} from '@souls/world-compiler';
import {readFileSync} from 'node:fs';import {registerHooks} from 'node:module';
import * as THREE from 'three';
import '../gen-mesh/kit.mesh.ts';
import {heldProjections} from '../../../../mars/viewer/app/engine-view/held-projection.ts';
// Production emitter + real source definitions; the fixture decoder has a single independent retained native answer.
import {canonicalAppearance} from '../../../../tools/world-launcher/canonical-appearance.mjs';
const KIND='eden:soup_bowl@12207564419b011f4ce981686d39b826d5d31c2efb240185c0fead65f515f3cd162f';
function appearanceFixture(){
 const entry=JSON.parse(readFileSync(new URL('../../../../content/kinds/food/soup_bowl.json',import.meta.url),'utf8'));
 const template=JSON.parse(readFileSync(new URL('../../../../worlds/templates/shared-camp-meal.json',import.meta.url),'utf8'));
 const source=template.batches.flatMap((b:{ops:{op:string;def?:{name:string}}[]})=>b.ops).find((op:{op:string;def?:{name:string}})=>op.op==='define'&&op.def?.name==='core-soup_bowl').def;
 const parsed=defSchema.parse(source),{budget,...body}=parsed,stored={...parsed,hash:hashOf(body),ref:'core-soup_bowl@1',by:'test',born:0};
 const line=`{1: "eden:soup_bowl", 2: "thing", 6: {}, 11: ["thing"], 19: "${stored.hash}"}`;
 const editKinds=(text:string)=>JSON.stringify(text===line?{[KIND]:{admits:['thing'],slots:{}}}:{});
 const facts=JSON.stringify({ground:{defs:[{ref:stored.ref,body:JSON.stringify(stored)}]},kinds:[{ref:stored.ref,hash:stored.hash}],things:[{id:'e_bowl0001',ref:stored.ref,def:stored.ref}]});
 return{input:{world:'meal',stream:'/s/meal/',facts,kinds:line,entries:[JSON.stringify(entry)],editKinds},entry,stored};
}
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function loaded(p=canonicalAppearance(appearanceFixture().input)){
 const bytes=JSON.stringify(p),hash=sha(bytes);const descriptor={url:`/w/meal/v2/appearance/${hash}.json`,sha256:hash,world:'meal',stream:'/s/meal/'};
 const options={world:'meal',stream:'/s/meal/',origin:'https://world.example',get:(async()=>new Response(bytes))as typeof fetch};
 return {value:(await loadCanonicalAppearance(descriptor,options))!,descriptor,options,bytes};
}
test('emitted bytes → verified world loader → SAME registry → real soup2/1/0 mesh, exact import owner and world-draw handoff',async()=>{
 const {value}=await loaded(),f=appearanceFixture();const kinds=new CreatorKinds();
 kinds.apply([{id:'ground',kind:'souls:ground',parent:null,defBodies:[[f.stored.ref,JSON.stringify(f.stored)]]}],[]);kinds.appearances(value.rows);
 const entry={id:'native-bowl',kind:KIND,def:f.stored.ref,origin:'e_bowl0001',parent:'native-body',slot:1,pos:[0,0,0]as const,rot:[2**30,0,0,0]as const,fields:{28:2}};
 assert.deepEqual(kinds.held(entry)?.grip,[.12,.06,0]);assert.deepEqual(heldProjections({observedAt:0,entries:[entry]},undefined),[],'appearance does not fabricate default body hand metadata');assert.equal(kinds.held({...entry,kind:KIND.replace(/.$/,'e')}),null);assert.equal(kinds.held({...entry,def:'other@1'}),null);assert.equal(kinds.held({...entry,origin:'e_other001'}),null);
 const release=setHeldKinds(kinds);(globalThis as {location?:unknown}).location??=new URL('https://world.example/w/meal/');
 const index=new URL('../gen-mesh/index.ts',import.meta.url).href;
 const hook=registerHooks({load(url,context,next){return url===index?{format:'module',shortCircuit:true,source:"export {meshFor} from './registry.ts';"}:next(url,context);}});
 const {WorldEntityLayer}=await import('../WorldEntityLayer.ts').finally(()=>hook.deregister());
 const layer=new WorldEntityLayer(p=>p),model=new WorldModel({constants:{ground:'land'},seed:'appearance'});model.library=coreLibrary();(layer as unknown as {model:WorldModel}).model=model;
 const drawn=(layer as unknown as{drawn:Map<string,unknown>}).drawn;drawn.set(entry.origin,{obj:new THREE.Group()});
 try{
  assert.equal(layer.heldPicture(entry),null,'old/imported world copy remains sole owner before handoff');
  kinds.apply([{id:entry.id,kind:entry.kind,parent:'world',origin:entry.origin,def:entry.def,pos:[0,0,0],rot:[2**30,0,0,0],slot:null}],[]);assert.equal(kinds.next({model:{entities:new Map([[entry.origin,{id:entry.origin,def:entry.def}]])},seq:1},0),null,'shape registration does not duplicate the imported world picture');
  drawn.delete(entry.origin);
  const bounds=[];
  for(const soup of [2,1,0]){const picture=layer.heldPicture({...entry,fields:{28:soup}})!;assert(picture,'canonical picture must exist after actual world draw removal');assert.equal(picture.object.userData.entity,entry.id);const box=new THREE.Box3().setFromObject(picture.object);assert(Math.abs(box.max.z-box.min.z-.24)<1e-7,'ten-segment canonical lathe has declared240mm diameter on Z');assert(Math.abs(box.max.y-.1)<1e-7);let colored=0;picture.object.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;const c=m.geometry.attributes.color;for(let i=0;c&&i<c.count;i++){if(c.getX(i)>.5&&c.getY(i)<.4&&c.getZ(i)<.1)colored++;}});bounds.push(colored);picture.dispose();assert.equal(picture.object.parent,null);}
  assert(bounds[0]>0&&bounds[1]>0&&bounds[2]===0,'actual baked soup geometry changes, empty bowl has no soup triangles');
  const stale=structuredClone(f.stored);stale.hash='a'.repeat(64);kinds.apply([{id:'ground',kind:'souls:ground',parent:null,defBodies:[[f.stored.ref,JSON.stringify(stale)]]}],[]);assert.equal(layer.heldPicture(entry),null,'mismatched live source StoredDef cannot project');
 }finally{drawn.delete(entry.origin);release();layer.dispose();}
});
test('loader rejects world/stream/asset/entry hash mismatch and leaves absent metadata unknown',async()=>{
 const x=await loaded();assert.equal(await loadCanonicalAppearance(undefined,x.options),null);
 for(const patch of [{world:'other'},{stream:'/s/old/'},{sha256:'a'.repeat(64)},{url:'https://foreign.example/file'}])await assert.rejects(loadCanonicalAppearance({...x.descriptor,...patch},x.options),/canonical-appearance/);
 const bad=JSON.parse(x.bytes);bad.rows[0].entrySHA256='a'.repeat(64);await assert.rejects(loaded(bad),/canonical-appearance/);
 const malformed=JSON.parse(x.bytes);malformed.rows[0].sourceEntry.sha256='broken';await assert.rejects(loaded(malformed),/canonical-appearance/);
 const wrong=JSON.parse(x.bytes);wrong.rows[0].entry.kind='eden:other';await assert.rejects(loaded(wrong),/canonical-appearance/);
 const duplicate=JSON.parse(x.bytes);duplicate.rows.push(duplicate.rows[0]);await assert.rejects(loaded(duplicate),/canonical-appearance/);
});
test('explicit creator definitions retain priority and absent import authority never gains a grip',async()=>{
 const {value}=await loaded(),f=appearanceFixture(),kinds=new CreatorKinds();kinds.appearances(value.rows);
 const entry={id:'bowl',kind:KIND,def:f.stored.ref,origin:'e_bowl0001',parent:'body',slot:1,pos:[0,0,0]as const,rot:[2**30,0,0,0]as const,fields:{28:2}};
 assert.equal(kinds.held(entry),null,'no public source StoredDef yet, never guessing a library alias');
 const custom=structuredClone(f.entry);custom.points.grip.at_mm=[40,50,60];
 kinds.apply([{id:'creator-kind',kind:'souls:kind',parent:null,defines:KIND,entry:new TextEncoder().encode(JSON.stringify(custom))}],[]);
 assert.deepEqual(kinds.held(entry)?.grip,[.04,.05,.06]);
});
