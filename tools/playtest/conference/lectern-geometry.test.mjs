import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanViews,setHumanGround} from '../../../mars/viewer/app/engine-view/humans.ts';
import {templateFromGltf} from '../../../mars/viewer/app/engine-view/people.ts';
import {CHARACTER_WIRE,CHARACTER_CLIPS} from '../../../mars/viewer/app/engine-view/character-wire.ts';
import {hashKinds} from '../../entry/format.mjs';
import {provenCases} from '../../entry/prove.mjs';

const entry=JSON.parse(await readFile(new URL('../../../content/kinds/hall/lecture.json',import.meta.url),'utf8'));
const rigDir=process.env.HUMAN_RIG_DIR??fileURLToPath(new URL('../../../mars/viewer/public/modular/environment/',import.meta.url));
const metre=(v)=>v.map(n=>n/1000);
const old=structuredClone(entry);
old.points.behind_the_lectern.at_mm=[0,100,-350];old.slots.lectern.at_mm=[0,100,-350];
old.geometry.bounds_mm=[1600,1300,1200];old.looks.shape.shapes[0].size=[1600,100,1200];

test('the current entry advances its content reference without editing an immutable library revision',()=>{
  assert.notEqual(hashKinds([entry]).get(entry.kind).ref,hashKinds([old]).get(old.kind).ref);
  assert.notEqual(hashKinds([entry]).get(entry.kind).beside,hashKinds([old]).get(old.kind).beside);
  assert.deepEqual(entry.slots.lectern.at_mm,entry.points.behind_the_lectern.at_mm);
  assert.deepEqual(entry.geometry.bounds_mm,entry.looks.shape.shapes[0].size.map((n,i)=>i===1?1300:n));
  const cases=provenCases([entry]);assert.equal(cases.ok,true,JSON.stringify(cases.findings));
});

async function template(name){
  const wire=CHARACTER_WIRE[name],loader=new GLTFLoader();
  loader.register(()=>({name:'lectern-test-material',loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const load=async(file,sha)=>{const bytes=await readFile(rigDir+'/'+file);assert.equal(createHash('sha256').update(bytes).digest('hex'),sha,'production asset must match CHARACTER_WIRE');return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');};
  const mesh=await load(wire.mesh,wire.meshSHA256),clips=await load(wire.clips,CHARACTER_CLIPS[wire.clips].sha256);mesh.animations=clips.animations;return templateFromGltf(name,mesh);
}

// OBB interior excludes a 1mm surface band. The upper tilted top is checked in its own authored frame.
function inside(p,shape){
  const at=metre(shape.at),half=metre(shape.size).map(n=>n/2),v=new THREE.Vector3(...p).sub(new THREE.Vector3(...at));
  const r=new THREE.Euler((shape.pitch??0)*Math.PI/180000,(shape.yaw??0)*Math.PI/180000,(shape.roll??0)*Math.PI/180000);
  v.applyQuaternion(new THREE.Quaternion().setFromEuler(r).invert());
  return v.toArray().every((n,i)=>Math.abs(n)<half[i]-.001);
}

test('representative production shoes clear the lectern base and stay over the authored dais',async t=>{
  setHumanGround(()=>0);
  try{for(const name of ['casual','punk','woman'])await t.test(name,async()=>{
    const views=new HumanViews();views.setTemplates([await template(name)]);
    let oldInside=0,newInside=0,minRear=Infinity,minSide=Infinity,maxBodyInside=0,footCount=0;
    try{for(const activity of ['idle','tell-story'])for(const age of [0,.25,.6,1,2.5]){
      const root=metre(entry.slots.lectern.at_mm);
      views.setFrame([{id:'lectern-clearance-'+name,p:root,yaw:Math.PI/2,walk:0,walkDist:0,activity,activityAge:age}],age);
      views.render(1);assert.deepEqual(views.bodyObject('lectern-clearance-'+name).position.toArray(),root,'renderer does not move the authored root');
      const skin=views.meshPoints('lectern-clearance-'+name,1),feet=skin.filter(p=>p.part==='foot');
      assert(feet.length>100,'both production shoes must contribute actual skin');footCount=feet.length;
      const anchors=views.bones()['lectern-clearance-'+name].feet,clusters=anchors.map(()=>[]);
      for(const point of feet){const distances=anchors.map(a=>Math.hypot(...a.map((n,i)=>n-point.p[i])));clusters[distances.indexOf(Math.min(...distances))].push(point);}
      for(const cluster of clusters){assert(cluster.length>100,'each inferred shoe cluster has actual skin');const sole=Math.min(...cluster.map(p=>p.p[1]));assert(sole>=.099&&sole<=.104,'both shoe soles reach the100mm support within4mm');}

      const dais=entry.looks.shape.shapes[0],half=metre(dais.size).map(n=>n/2);
      for(const p of feet){
        minRear=Math.min(minRear,p.p[2]+half[2]);minSide=Math.min(minSide,half[0]-Math.abs(p.p[0]));
        assert(p.p[2]>-half[2]+.01&&p.p[2]<half[2]-.01&&Math.abs(p.p[0])<half[0]-.01,'every shoe vertex stays above the platform footprint with10mm edge margin');
        assert(p.p[1]>=.1-.001,'shoes do not penetrate the100mm support top');
        newInside+=+inside(p.p,entry.looks.shape.shapes[1]);
        oldInside+=+inside([p.p[0],p.p[1],p.p[2]+(old.slots.lectern.at_mm[2]-entry.slots.lectern.at_mm[2])/1000],old.looks.shape.shapes[1]);
      }
      const hits=skin.filter(p=>entry.looks.shape.shapes.slice(1).some((s)=>inside(p.p,s)));maxBodyInside=Math.max(maxBodyInside,hits.length);

    }
    assert.equal(newInside,0,'no actual shoe vertex is inside the wooden base');
    assert(oldInside>0,'the independent old-standing-location counterfactual must reproduce overlap');
    assert.equal(maxBodyInside,0,'standing/story skin clears all authored wooden parts');
    t.diagnostic(JSON.stringify({name,footCount,oldInside,newInside,minRear,minSide,maxBodyInside}));
    }finally{views.clear();}
  });}finally{setHumanGround(null);}
});
