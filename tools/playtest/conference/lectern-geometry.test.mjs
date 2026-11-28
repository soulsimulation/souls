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
import {chunkOf,TICK_US} from '../../../apps/web/src/v2-engine/takes.ts';
import {TakePeople} from '../../../mars/viewer/app/engine-view/take-replay.ts';

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


// The retained native clap for=1 spans1.8s; its idle tail folds the immutable outgoing pose for350ms.
// Public world coordinates preserve the actual lectern's pi parent turn, not a generic point stand-in.
const EPOCH=1795837089,CLAP_START=1.75,CLAP_END=3.55;
function returnTake(name,fromTick=EPOCH*1e6/TICK_US,ticks=100){
  const at=s=>(EPOCH+s)*1e6,root=metre(entry.slots.lectern.at_mm),p=[-root[0]*1000,root[1]*1000,(4-root[2])*1000];
  const body={entity:'lectern-return-'+name,soul:'lectern-source-'+name,name:'Presenter',heading:-Math.PI/2,
    samples:[{at:at(0),p},{at:at(5),p}],gestures:[
      {start:at(.1),end:at(CLAP_START),activity:'point',target:'question',toward:[3000,3000],run:'point-before-clap',point:{hand:'left',ends:[at(.4),at(CLAP_START)]}},
      {start:at(CLAP_START),end:at(CLAP_END),activity:'clap'}]};
  return chunkOf([body],fromTick,{rulesVersion:'lectern-return/1',datetime:null},ticks).take;
}
const separation=(a,b)=>Math.max(...a.map((p,i)=>Math.hypot(...p.p.map((n,j)=>n-b[i].p[j]))));

test('named point and immutable clap return clear wood on complete production skin',async t=>{
  setHumanGround(()=>0);
  try{for(const name of ['casual','punk','woman'])await t.test(name,async()=>{
    const source=await template(name),take=returnTake(name),people=new TakePeople(take),id='lectern-return-'+name;
    people.setTemplates([source]);const views=people.humans,root=metre(entry.slots.lectern.at_mm),worldRoot=[-root[0],root[1],4-root[2]];
    let sampled;const set=views.setFrame.bind(views);views.setFrame=(samples,...args)=>{sampled=samples[0];return set(samples,...args);};
    const draw=(time,player=people)=>{player.show(time,EPOCH+time);return player.humans.meshPoints(id,1);};
    const priorTop=structuredClone(entry.looks.shape.shapes[3]);priorTop.at[2]=60;
    let oldTopInside=0,maxInside=0,minRear=Infinity,minSide=Infinity,minSole=Infinity,maxSole=-Infinity,worst=null;
    try{
      const point=draw(1.1);assert.equal(sampled.pointAim.target,'question');assert.equal(sampled.pointAim.hand,'left');
      const arm=views.bones(id)[id].arms.find(a=>a.side==='left');
      const expected=new THREE.Vector2(3-arm.shoulder[0],3-arm.shoulder[2]).normalize(),actual=new THREE.Vector2(arm.palm[0]-arm.shoulder[0],arm.palm[2]-arm.shoulder[2]).normalize();
      assert(expected.dot(actual)>.999,'the real named point reaches toward the question');
      const times=[...Array.from({length:205},(_,i)=>i*.02),CLAP_START-1e-5,CLAP_START+1e-5,CLAP_END-1e-5,CLAP_END+1e-5,CLAP_END+.11427115,CLAP_END+.2908577,CLAP_END+.35].sort((a,b)=>a-b);
      for(const time of times){
        const skin=draw(time),local=skin.map(p=>({...p,p:[-p.p[0],p.p[1],4-p.p[2]]}));
        assert.deepEqual(views.bodyObject(id).position.toArray(),worldRoot,'the sampled native root stays exact');
        assert.equal(sampled.yaw,-Math.PI/2,'authored standing heading stays exact');
        const hits=local.filter(p=>entry.looks.shape.shapes.slice(1).some(s=>inside(p.p,s)));
        if(hits.length>maxInside){maxInside=hits.length;worst={time,part:hits[0].part,p:hits[0].p};}
        if(time>=CLAP_END&&time<=CLAP_END+.35)oldTopInside+=local.filter(p=>inside(p.p,priorTop)).length;
        const feet=local.filter(p=>p.part==='foot'),anchors=views.bones(id)[id].feet,clusters=anchors.map(()=>[]);
        assert(feet.length>100,'actual visible shoe skin is present');
        for(const p of feet){
          const world=[-p.p[0],p.p[1],4-p.p[2]],distance=anchors.map(a=>Math.hypot(...a.map((n,i)=>n-world[i])));clusters[distance.indexOf(Math.min(...distance))].push(p);
          const half=metre(entry.looks.shape.shapes[0].size).map(n=>n/2);minRear=Math.min(minRear,p.p[2]+half[2]);minSide=Math.min(minSide,half[0]-Math.abs(p.p[0]));
          assert(p.p[2]>-half[2]+.01&&p.p[2]<half[2]-.01&&Math.abs(p.p[0])<half[0]-.01,'every shoe vertex retains10mm platform edge clearance');
          assert(p.p[1]>=.099,'shoe skin does not enter the support');
        }
        for(const cluster of clusters){assert(cluster.length>100);const sole=Math.min(...cluster.map(p=>p.p[1]));minSole=Math.min(minSole,sole);maxSole=Math.max(maxSole,sole);assert(sole>=.099&&sole<=.104,'both soles stay on their100mm platform');}
      }
      for(const time of [CLAP_START,CLAP_END])assert(separation(draw(time-1e-5),draw(time+1e-5))<.001,'the real entry/return stays continuous');
      for(const time of [CLAP_END+.11427115,CLAP_END+.2908577,1.1]){
        const warm=draw(time),cold=new TakePeople(take);cold.setTemplates([source]);
        try{assert(separation(warm,draw(time,cold))<1e-5,'cold/backward seek reconstructs the same immutable skin');}finally{cold.dispose();}
      }
      const chunks=[returnTake(name,Math.round(EPOCH*1e6/TICK_US),70),returnTake(name,Math.round(EPOCH*1e6/TICK_US)+70,30)];
      const adjacent=new TakePeople(chunks[0]);adjacent.setTemplates([source]);adjacent.setWaterHistory(chunks);
      try{adjacent.show(3.45,EPOCH+3.45);adjacent.setTake(chunks[1]);adjacent.setWaterHistory(chunks);const time=CLAP_END+.11427115;adjacent.show(time-3.5,EPOCH+time);assert(separation(draw(time),adjacent.humans.meshPoints(id,1))<1e-5,'adjacent take preserves the outgoing clap origin');}finally{adjacent.dispose();}
      t.diagnostic(JSON.stringify({name,oldTopInside,maxInside,worst,minRear,minSide,minSole,maxSole}));
      assert(oldTopInside>0,'the independent original top must reproduce the clap return penetration');
      assert.equal(maxInside,0,'complete named-point/clap/idle skin stays outside all wooden parts');
    }finally{people.dispose();}
  });}finally{setHumanGround(null);}
});
