import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {templateFromGltf} from './people.ts';
import {CHARACTER_WIRE} from './character-wire.ts';
import {HumanViews,setHumanGround,type SampledHuman} from './humans.ts';

const rigDir=process.env.HUMAN_RIG_DIR??fileURLToPath(new URL('../../public/modular/environment/',import.meta.url));
async function template(name:'woman'|'casual') {
  const loader=new GLTFLoader();
  loader.register(()=>({name:'held-test-material',loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const load=async(file:string)=>{const bytes=await readFile(rigDir+'/'+file);return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');};
  const wire=CHARACTER_WIRE[name],mesh=await load(wire.mesh);mesh.animations=(await load(wire.clips)).animations;
  return templateFromGltf(name,mesh);
}

function snapshot(views:HumanViews,id:string) {
  const holder=views.bodyObject(id)!,points:THREE.Vector3[]=[],feet:Record<string,number>={},bones:Record<string,{position:THREE.Vector3;world:THREE.Vector3}>={};
  holder.updateMatrixWorld(true);
  holder.traverse(object=>{
    if((object as THREE.Bone).isBone) {
      const expected=object.parent!.matrixWorld.clone().multiply(object.matrix);
      assert(object.matrixWorld.equals(expected),'posed or held bone matrices remain coherent');
      bones[object.name]={position:object.position.clone(),world:new THREE.Vector3().setFromMatrixPosition(object.matrixWorld)};
    }
    const mesh=object as THREE.SkinnedMesh;if(!mesh.isSkinnedMesh||mesh.userData.bodyDraw)return;
    const pos=mesh.geometry.getAttribute('position'),index=mesh.geometry.getAttribute('skinIndex'),weight=mesh.geometry.getAttribute('skinWeight');
    for(let i=0;i<pos.count;i++) {
      const point=mesh.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);points.push(point);
      let k=0;for(let j=1;j<4;j++)if(weight.getComponent(i,j)>weight.getComponent(i,k))k=j;
      const name=mesh.skeleton.bones[index.getComponent(i,k)]?.name;
      if(name==='FootL'||name==='FootR')feet[name]=Math.min(feet[name]??Infinity,point.y);
    }
  });
  assert(points.length>1000);for(const name of ['FootL','FootR'])assert(feet[name]>=.001,name+' retains positive ground contact');
  return{points,bones,root:holder.position.clone(),quaternion:holder.quaternion.clone(),scale:holder.scale.clone()};
}

test('held rigs resume the same full pose before upright ground fitting',async()=>{
  const templates=new Map(await Promise.all((['woman','casual']as const).map(async name=>[name,await template(name)]as const)));
  const views=new HumanViews();views.setBodyTemplates(templates);setHumanGround(()=>0);
  const clock=1795672414,ids=['held-wave-body','held-idle-body'];
  const frame=(age:number):SampledHuman[]=>ids.map((id,i)=>({id,p:i===0?[1,0,0]:[.542,0,-.458],yaw:-.785,walk:0,walkDist:0,bodyModel:i===0?'woman':'casual',activity:i===0?'wave':'idle',baseActivity:'idle',activityAge:i===0?age:undefined,prevActivity:i===0?'idle':undefined,prevWaveDuration:1.2,restAge:20,waveSamples:i===0?[{age}]:undefined,waveClock:clock+age}));
  const draw=(age:number)=>{views.setFrame(frame(age),clock+age);views.render(1);return ids.map(id=>snapshot(views,id));};
  const compare=(expected:ReturnType<typeof draw>,actual:ReturnType<typeof draw>)=>actual.forEach((body,i)=>{
    const before=expected[i];assert.equal(body.points.length,before.points.length);
    assert.deepEqual(body.root,before.root);assert.deepEqual(body.quaternion,before.quaternion);assert.deepEqual(body.scale,before.scale);
    assert(Math.max(...body.points.map((p,j)=>p.distanceTo(before.points[j])))<=1e-5,'same-clock full production skin is deterministic');
    for(const [name,bone]of Object.entries(body.bones)) {
      assert(bone.position.distanceTo(before.bones[name].position)<=1e-5,name+' local position');
      assert(bone.world.distanceTo(before.bones[name].world)<=1e-5,name+' world position');
    }
  });
  try {
    for(const age of [.25,.35,.5,.65,.8])draw(age);
    views.clear();const expected=draw(.5);compare(expected,draw(.5));
    views.viewer={eye:new THREE.Vector3(1000,1000,1000),frustum:new THREE.Frustum(new THREE.Plane(new THREE.Vector3(1,0,0),-10000)),nearM:1,farM:2};
    let held=0,posed=0,resumed=false;
    for(let i=0;i<16;i++) {
      compare(expected,draw(.5));
      if(held>0&&views.poseStats.posed>0)resumed=true;
      held+=views.poseStats.held;posed+=views.poseStats.posed;
    }
    assert(held>0&&posed>=4&&resumed,'real offscreen scheduler holds both rigs and subsequently poses them again');
  } finally {views.clear();setHumanGround(null);}
});
