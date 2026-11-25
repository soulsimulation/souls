// A classic body (casual, punk, woman: 9 to 13 skinned primitives) draws as one skinned mesh with the palette material
// (mars/viewer/app/engine-view/body-merge.ts). The merged draw must carry every primitive's vertices, skin, colour,
// finish role and roughness, keep the renderer's per-body draw order, skin to the same place, and stay out of the way
// of what reads the primitives (they stay, hidden).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createRig as makeRig,templateFromGltf,type Template} from '../../../mars/viewer/app/engine-view/people.ts';
import {applyHumanFinish,humanFinishRoleIdOf} from '../../../mars/viewer/app/engine-view/content/details/human-presets/finish.ts';
import {BODY_DRAW,mergeRigBody,setBodyMerged} from '../../../mars/viewer/app/engine-view/body-merge.ts';

// as HumanViews.make does for every body it shows
const createRig=(t:Template)=>{const r=makeRig(t);mergeRigBody(r);return r;};

const load=(name:string)=>{const b=readFileSync(new URL(`../../../mars/viewer/public/modular/environment/animated-${name}.glb`,import.meta.url));return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
const skinned=(root:THREE.Object3D)=>{const out:THREE.SkinnedMesh[]=[];root.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)out.push(o as THREE.SkinnedMesh);});return out;};
const shown=(o:THREE.Object3D)=>{for(let p:THREE.Object3D|null=o;p;p=p.parent)if(!p.visible)return false;return true;};

for(const name of ['casual','punk','woman'] as const)test(`${name}: one draw with every primitive's vertices, colour, role and roughness, skinned the same`,async()=>{
 const t=templateFromGltf(name,await load(name));applyHumanFinish(name,t.gltf.scene);
 const rig=createRig(t),all=skinned(rig.model),body=all.find(m=>m.userData[BODY_DRAW])!,parts=all.filter(m=>m!==body);
 assert.ok(body&&parts.length>=9,'merged draw beside the primitives');
 assert.deepEqual(all.filter(shown),[body],'only the merged draw is drawn');
 assert.equal(body.castShadow,true);assert.equal(body.frustumCulled,parts[0].frustumCulled);
 const g=body.geometry,info=g.getAttribute('hinfo'),pal=(body.material as THREE.MeshStandardMaterial).userData.humanoid.palette as Float32Array;
 // vertices in scene order, each with its primitive's material as palette colour, finish role and roughness
 let v=0;const starts:number[]=[];
 for(const p of parts){const a=p.geometry.attributes,m=p.material as THREE.MeshStandardMaterial;starts.push(v);
  for(let i=0;i<a.position.count;i++,v++){
   for(let k=0;k<3;k++)assert.equal(g.attributes.position.getComponent(v,k),a.position.getComponent(i,k));
   for(let k=0;k<4;k++){assert.equal(g.attributes.skinIndex.getComponent(v,k),a.skinIndex.getComponent(i,k));assert.equal(g.attributes.skinWeight.getComponent(v,k),a.skinWeight.getComponent(i,k));}
   const s=info.getX(v);assert.deepEqual([pal[s*3],pal[s*3+1],pal[s*3+2]],[m.color.r,m.color.g,m.color.b].map(Math.fround));
   assert.equal(info.getY(v),humanFinishRoleIdOf(m));assert.equal(info.getZ(v)/255,Math.fround(m.roughness*255)/255);
  }}
 assert.equal(v,g.attributes.position.count);
 // triangles: each primitive's, in the renderer's order for one body (material id, then scene order)
 const order=parts.map((_,i)=>i).sort((x,y)=>(parts[x].material as THREE.Material).id-(parts[y].material as THREE.Material).id||x-y),want:number[]=[];
 for(const k of order){const I=parts[k].geometry.index!;for(let i=0;i<I.count;i++)want.push(I.getX(i)+starts[k]);}
 assert.deepEqual(Array.from(g.index!.array),want);
 // posed mid-walk, the merged vertices skin to exactly where the primitives' do
 rig.walk.setEffectiveWeight(1);rig.mixer.update(.37);rig.holder.updateMatrixWorld(true);
 const a=new THREE.Vector3(),b=new THREE.Vector3();
 parts.forEach((p,k)=>{for(let i=0;i<p.geometry.attributes.position.count;i+=7){p.getVertexPosition(i,a).applyMatrix4(p.matrixWorld);body.getVertexPosition(starts[k]+i,b).applyMatrix4(body.matrixWorld);assert.ok(a.distanceTo(b)<1e-6,`${name} part ${k} vertex ${i}`);}});
 // a preset recolouring the primitives shows them again
 setBodyMerged(rig,false);assert.deepEqual(skinned(rig.model).filter(shown),parts);
 setBodyMerged(rig,true);assert.deepEqual(skinned(rig.model).filter(shown),[body]);
 // never picked: picking reads the primitives as before
 const hits:THREE.Intersection[]=[];body.raycast(new THREE.Raycaster(new THREE.Vector3(0,1,5),new THREE.Vector3(0,0,-1)),hits);assert.equal(hits.length,0);
});

test('bodies of one template share the merged geometry and material; an unfinished template is not merged',async()=>{
 const t=templateFromGltf('punk',await load('punk'));
 assert.ok(!skinned(createRig(t).model).some(m=>m.userData[BODY_DRAW]),'unfinished materials: separate draws');
 applyHumanFinish('punk',t.gltf.scene);
 const [x,y]=[createRig(t),createRig(t)].map(r=>skinned(r.model).find(m=>m.userData[BODY_DRAW])!);
 assert.equal(x.geometry,y.geometry);assert.equal(x.material,y.material);assert.notEqual(x.skeleton,y.skeleton);
});

test('a palette material copy keeps its shader hooks (a fading ghost keeps its colours)',async()=>{
 const t=templateFromGltf('woman',await load('woman'));applyHumanFinish('woman',t.gltf.scene);
 const m=skinned(createRig(t).model).find(o=>o.userData[BODY_DRAW])!.material as THREE.MeshStandardMaterial,c=m.clone();
 assert.equal(c.onBeforeCompile,m.onBeforeCompile);assert.equal(c.customProgramCacheKey(),m.customProgramCacheKey());assert.equal(c.userData.humanoid,m.userData.humanoid);
 const cc=c.clone();assert.equal(cc.onBeforeCompile,m.onBeforeCompile);
});
