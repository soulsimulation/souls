import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {cullAsOneBody} from '../../../mars/viewer/app/engine-view/people.ts';

// A body of two skinned parts on one skeleton (a torso at hip height and an eye at head height) and a rigid prop.
function body(){
 const bone=new THREE.Bone(),skeleton=new THREE.Skeleton([bone]),holder=new THREE.Group();
 const part=(h:number,y:number)=>{const g=new THREE.BoxGeometry(.3,h,.3).translate(0,y,0),n=g.attributes.position.count;
  g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(n*4),4));g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(new Float32Array(n*4).map((_,i)=>i%4?0:1),4));
  const m=new THREE.SkinnedMesh(g,new THREE.MeshBasicMaterial());m.add(bone);m.bind(skeleton);m.frustumCulled=false;return m;};
 const torso=part(1.6,.9),eye=part(.02,1.65),prop=new THREE.Mesh(new THREE.BoxGeometry(.1,.1,.1),new THREE.MeshBasicMaterial());prop.position.set(.3,1,0);prop.frustumCulled=false;
 holder.add(torso,eye,prop);return {holder,torso,eye,prop};
}
const visible=(camera:THREE.PerspectiveCamera,o:THREE.Object3D)=>{camera.updateMatrixWorld();o.updateWorldMatrix(true,false);
 const f=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));return o.frustumCulled===false||f.intersectsObject(o as THREE.Mesh);};

test('a body is culled whole when off screen, and every part of it is drawn while any of it may be on screen',()=>{
 const {holder,torso,eye,prop}=body();cullAsOneBody(holder);
 for(const m of [torso,eye,prop])assert.equal(m.frustumCulled,true);
 assert.ok(eye.boundingSphere!.radius>=1.6,'the eye is culled by the whole body\'s sphere, not its own');
 const camera=new THREE.PerspectiveCamera(40,1,.1,500);camera.position.set(0,1,10);camera.lookAt(0,1,0);
 holder.position.set(0,0,0);for(const m of [torso,eye,prop])assert.equal(visible(camera,m),true);
 // lying down: the eye a metre and a half to the side of where it rests, near the frame's edge, is still drawn
 holder.position.set(4.6,-1.4,0);assert.equal(visible(camera,eye),true);
 holder.position.set(60,0,0);for(const m of [torso,eye,prop])assert.equal(visible(camera,m),false,'off screen: not drawn');
 holder.position.set(0,0,30);assert.equal(visible(camera,torso),false,'behind the camera: not drawn');
});
