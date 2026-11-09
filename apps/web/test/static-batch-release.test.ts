import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {StaticBatchOwner} from '../src/rendering/StaticBatchOwner.ts';
// PERF-HEAP (#1473): a merged batch drops its CPU arrays after its first upload and still validates and draws.
// Node has no GL, so the test plays WebGLAttributes' part: it calls each uploaded attribute's onUploadCallback.
function fixture(material:THREE.Material=new THREE.MeshStandardMaterial()){const scene=new THREE.Scene(),root=new THREE.Group(),a=new THREE.Mesh(new THREE.BoxGeometry(),material),b=new THREE.Mesh(new THREE.BoxGeometry(),material);b.position.x=2;root.add(a,b);scene.add(root);scene.updateMatrixWorld(true);return{scene,root,a,b};}
const upload=(g:THREE.BufferGeometry)=>{for(const a of Object.values(g.attributes))(a as THREE.BufferAttribute).onUploadCallback();g.index?.onUploadCallback();};
const merged=(owner:StaticBatchOwner)=>owner.group.children.map(m=>(m as THREE.Mesh).geometry);
test('an uploaded batch drops its arrays, keeps its counts and bounds, and still draws; sources keep theirs',async()=>{
 const f=fixture(),owner=new StaticBatchOwner(f.scene);await owner.prepare([f.root],{generation:1});
 const [g]=merged(owner),counts=Object.values(g.attributes).map(a=>a.count),indexCount=g.index!.count,bytes=owner.inspection().mergedBytes,sphere=g.boundingSphere!.clone();
 owner.withRender(()=>assert.equal(f.a.visible,false));assert.equal(owner.inspection().releasedBytes,0);
 upload(g);
 assert.ok(Object.values(g.attributes).every(a=>a.array.length===0));assert.equal(g.index!.array.length,0);assert.ok(g.attributes.position.array instanceof Float32Array);
 assert.deepEqual(Object.values(g.attributes).map(a=>a.count),counts);assert.equal(g.index!.count,indexCount);assert.ok(g.boundingSphere!.equals(sphere));
 assert.equal(owner.inspection().releasedBytes,bytes);assert.equal(owner.inspection().mergedBytes,bytes);
 for(let i=0;i<3;i++)owner.withRender(()=>{assert.equal(f.a.visible,false);assert.equal(owner.inspection().fallbackLastRender,0);});
 assert.ok(f.a.geometry.attributes.position.array.length>0);
 upload(g);assert.equal(owner.inspection().releasedBytes,bytes);  // a second upload releases nothing more
 owner.dispose();
});
test('a released batch is reused by an incremental prepare; a changed source still falls back and re-merges',async()=>{
 const f=fixture(),owner=new StaticBatchOwner(f.scene);await owner.prepare([f.root],{generation:1,incremental:true});upload(merged(owner)[0]);
 await owner.prepare([f.root],{generation:2,incremental:true});assert.equal(owner.inspection().reusedBatches,1);owner.withRender(()=>assert.equal(f.a.visible,false));
 f.a.rotation.y=.3;f.scene.updateMatrixWorld(true);owner.withRender(()=>assert.equal(f.a.visible,true));
 await owner.prepare([f.root],{generation:3,incremental:true});assert.equal(owner.inspection().reusedBatches,0);const [g]=merged(owner);assert.ok(g.attributes.position.array.length>0);owner.withRender(()=>assert.equal(f.a.visible,false));
 owner.dispose();
});
test('reset after a release (context restored) rebuilds full arrays from the sources',async()=>{
 const f=fixture(),owner=new StaticBatchOwner(f.scene);await owner.prepare([f.root],{generation:1});upload(merged(owner)[0]);
 owner.reset();assert.equal(owner.inspection().batches,0);owner.withRender(()=>assert.equal(f.a.visible,true));
 await owner.prepare([f.root],{generation:2});const [g]=merged(owner);assert.ok(g.attributes.position.array.length>0);owner.withRender(()=>assert.equal(f.a.visible,false));owner.dispose();
});
test('a wireframe batch keeps its arrays (three builds its line index from them)',async()=>{
 const f=fixture(new THREE.MeshStandardMaterial({wireframe:true})),owner=new StaticBatchOwner(f.scene);await owner.prepare([f.root],{generation:1});
 if(!owner.inspection().batches){owner.dispose();return;}  // not eligible to merge at all: nothing to keep
 const [g]=merged(owner);upload(g);assert.ok(g.attributes.position.array.length>0);assert.equal(owner.inspection().releasedBytes,0);owner.dispose();
});
