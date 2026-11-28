import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {heldProjections,placeHeld,type NativeHands,type HeldPicture} from './held-projection.ts';
import type {HeldEntry} from './held-entry.ts';
const Q=2**30;
const entry:HeldEntry={id:'bowl',kind:'eden:soup_bowl@aa',parent:'body',slot:7,pos:[0,0,0],rot:[Q,0,0,0]};
const body:NativeHands={body:'body',kindHash:'ab'.repeat(32),resources:[['souls:hand-left',2,7],['souls:hand-right',2,4]]};
test('declared resources bind exact occupants without inferring default hand slots',()=>{
  const set={observedAt:1,entries:[entry]};
  assert.deepEqual(heldProjections(set,body).map(x=>x.hand),['left']);
  assert.deepEqual(heldProjections(set,undefined),[]);
  assert.deepEqual(heldProjections({...set,entries:[{...entry,slot:1}]},body),[]);
  assert.deepEqual(heldProjections({...set,entries:[entry,{...entry,id:'duplicate'}]},body),[]);
  assert.deepEqual(heldProjections({...set,entries:[{...entry,parent:'other'}]},body),[]);
  assert.deepEqual(heldProjections({observedAt:2,entries:[]},body),[]);
  assert.deepEqual(heldProjections(set,{...body,resources:[['souls:gripper',2,7]]}),[]);
});
test('canonical grip meets palm with native local translation/quaternion applied once and arbitrary scene parent',()=>{
  const parent=new THREE.Group();parent.position.set(3,2,1);parent.rotation.y=.4;
  const object=new THREE.Group();parent.add(object);
  const picture:HeldPicture={object,grip:[.12,.06,0],dispose(){}};
  const palm=new THREE.Vector3(8,1,4),bodyRotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),.7);
  for(const rot of [[Q,0,0,0],[Math.round(Q*Math.SQRT1_2),0,Math.round(Q*Math.SQRT1_2),0]] as const){
    const held={...entry,pos:[10000,20000,-30000] as const,rot};
    placeHeld(picture,held,palm,bodyRotation,parent);
    const grip=object.localToWorld(new THREE.Vector3(...picture.grip));
    assert(grip.distanceTo(palm.clone().add(new THREE.Vector3(.01,.02,-.03).applyQuaternion(bodyRotation)))<1e-8);
    const expected=bodyRotation.clone().multiply(new THREE.Quaternion(rot[1],rot[2],rot[3],rot[0]).normalize());
    assert(object.getWorldQuaternion(new THREE.Quaternion()).angleTo(expected)<1e-7);
  }
});

test('malformed recorded body metadata and native slots are not interpreted as contacts',async()=>{
  const {nativeHandsOf}=await import('./held-projection.ts');
  assert.equal(nativeHandsOf({family:'humanoid'}),undefined);
  assert.equal(nativeHandsOf({nativeBody:'body',nativeKindHash:'ab'.repeat(32),nativeResources:[null]}),undefined);
  assert.equal(nativeHandsOf({nativeBody:'body',nativeKindHash:'ab'.repeat(32),nativeResources:[['souls:hand-left',2,0]]}),undefined);
  assert.deepEqual(nativeHandsOf({nativeBody:'body',nativeKindHash:body.kindHash,nativeResources:body.resources}),body);
});

test('holding clearance uses transformed actual mesh extent and excludes decorative/shadow geometry',async()=>{
  const {heldMeshBounds,heldBackExtent}=await import('./held-projection.ts');
  const object=new THREE.Group(),solid=new THREE.Mesh(new THREE.BoxGeometry(.24,.1,.24),new THREE.MeshBasicMaterial());object.add(solid);
  const effect=new THREE.Group();effect.userData.role='steam';effect.add(new THREE.Mesh(new THREE.BoxGeometry(100,100,100),new THREE.MeshBasicMaterial()));object.add(effect);
  const shadow=solid.clone();shadow.scale.setScalar(50);shadow.userData.shadowProxy=true;object.add(shadow);
  const box=heldMeshBounds(object);assert(Math.abs(box.getSize(new THREE.Vector3()).x-.24)<1e-7);
  const picture:HeldPicture={object,grip:[.12,.06,0],bounds:{min:box.min.toArray(),max:box.max.toArray()},dispose(){}};
  assert(Math.abs(heldBackExtent(picture,entry)-.24)<1e-7);
  const reversed={...entry,rot:[0,0,Q,0] as const};assert(heldBackExtent(picture,reversed)<1e-7,'native local rotation changes the grip-relative rear extent');
});
