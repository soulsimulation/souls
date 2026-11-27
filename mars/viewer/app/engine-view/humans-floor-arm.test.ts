import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {CHARACTER_WIRE,CHARACTER_CLIPS} from './character-wire.ts';
import {templateFromGltf,createRig} from './people.ts';
import {HumanViews,setHumanGround,type SampledHuman} from './humans.ts';
import {idPhase} from './activity-poses.ts';

const rigDir=process.env.HUMAN_RIG_DIR??fileURLToPath(new URL('../../public/modular/environment/',import.meta.url));
async function template(name:'woman'|'casual') {
  const loader=new GLTFLoader(),wire=CHARACTER_WIRE[name];
  const load=async(file:string,sha:string)=>{const b=await readFile(rigDir+'/'+file);assert.equal(createHash('sha256').update(b).digest('hex'),sha);return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
  // These production GLBs have no textures: retain their real materials and merged draw path.
  const mesh=await load(wire.mesh,wire.meshSHA256);mesh.animations=(await load(wire.clips,CHARACTER_CLIPS[wire.clips].sha256)).animations;
  return templateFromGltf(name,mesh);
}
function points(holder:THREE.Object3D,merged:boolean) {
  const out:{bone:string;p:THREE.Vector3}[]=[];let meshes=0;
  holder.traverse(object=>{
    const m=object as THREE.SkinnedMesh;if(!m.isSkinnedMesh||!!m.userData.bodyDraw!==merged)return;
    if(merged){assert(m.visible);assert(!Array.isArray(m.material)&&m.material.visible);meshes++;}
    const g=m.geometry,index=g.index;assert(index,'production draw is indexed');
    const start=g.drawRange.start,end=Math.min(index.count,start+g.drawRange.count);
    const vertices=new Set<number>();for(let i=start;i<end;i++)vertices.add(index.getX(i));
    const si=g.getAttribute('skinIndex'),sw=g.getAttribute('skinWeight');
    for(const i of vertices){let k=0;for(let j=1;j<4;j++)if(sw.getComponent(i,j)>sw.getComponent(i,k))k=j;
      out.push({bone:m.skeleton.bones[si.getComponent(i,k)].name,p:m.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(m.matrixWorld)});
    }
  });
  if(merged)assert.equal(meshes,1,'actual merged body is drawable');return out;
}
function lengths(holder:THREE.Object3D) {
  return ['L','R'].flatMap(side=>['UpperArm','UpperLeg'].flatMap(part=>{
    const names=part==='UpperArm'?['UpperArm','LowerArm','Wrist']:['UpperLeg','LowerLeg','Foot'];
    const p=names.map(name=>holder.getObjectByName(name+side)!.getWorldPosition(new THREE.Vector3()));return[p[0].distanceTo(p[1]),p[1].distanceTo(p[2])];
  }));
}
function maxDelta(a:ReturnType<typeof points>,b:ReturnType<typeof points>) {assert.equal(a.length,b.length);return Math.max(...a.map((p,i)=>p.p.distanceTo(b[i].p)));}

test('free floor recovery preserves planted hands and the attained elbow plane',async()=>{
  const templates=new Map(await Promise.all((['woman','casual']as const).map(async name=>[name,await template(name)]as const)));
  const fresh=()=>{const v=new HumanViews();v.setTemplates([...templates.values()]);v.setBodyTemplates(templates);return v;};
  const views=fresh();setHumanGround(()=>0);
  // A neutral id at an ordinary clock; seconds+idPhase*7=100 begins the low push-up phase.
  const id='floor-arm-contact',clock=100-idPhase(id)*7;
  const frame=(model:'woman'|'casual',activity:string,age?:number):SampledHuman=>({id,p:[1,0,0],yaw:3.1411853071795868,walk:0,walkDist:0,bodyModel:model,activity,...(age===undefined?{}:{activityAge:age,postureChange:{from:activity==='pushups'?'idle':'pushups',to:activity,age,fromAge:4}})});
  try{for(const model of ['woman','casual']as const){
    views.clear();const ref=createRig(templates.get(model)!);ref.holder.updateMatrixWorld(true);const originalLengths=lengths(ref.holder);ref.mixer.stopAllAction();
    const at=(activity:string,offset:number,age?:number)=>{
      views.setFrame([frame(model,activity,age)],clock+offset);views.render(1);
      const holder=views.bodyObject(id)!;holder.updateMatrixWorld(true);const drawn=points(holder,true);
      assert.equal(holder.position.x,1);assert.equal(holder.position.z,0);assert(holder.position.y>=0&&holder.position.y<=.061);
      lengths(holder).forEach((n,i)=>assert(Math.abs(n-originalLengths[i])<=1e-5,'actual arm and leg segment lengths stay fixed'));
      for(const side of ['L','R']){
        const foot=drawn.filter(p=>p.bone==='Foot'+side),hand=drawn.filter(p=>/^(Wrist|Thumb|Index|Middle|Ring|Pinky)/.test(p.bone)&&p.bone.endsWith(side));
        assert(foot.length>100&&hand.length>100,'both indexed support sets are populated');
        assert(Math.min(...foot.map(p=>p.p.y))>=-.001,'foot does not penetrate');
        assert(Math.min(...hand.map(p=>p.p.y))>=-.001,'hand does not penetrate');
        if(activity==='pushups'&&age===undefined){
          assert(Math.min(...foot.map(p=>p.p.y))<=.025,'both feet stay supported');
          const low=Math.min(...hand.map(p=>p.p.y));assert(low<=.010,`${model} ${side} hand floats ${low}m`);
          const shoulder=holder.getObjectByName('UpperArm'+side)!.getWorldPosition(new THREE.Vector3()),elbow=holder.getObjectByName('LowerArm'+side)!.getWorldPosition(new THREE.Vector3());
          assert(elbow.y-shoulder.y<=.5*shoulder.distanceTo(elbow),'steady plank does not turn the elbow nearly upward');
        }
      }return drawn;
    };
    for(const offset of [0,.4,.9,5/3,2.5])at('pushups',offset);
    // This natural phase straddles the woman's first-pass 2 mm support threshold.
    // Logging-only source audit observes opposite eligibility at these fixed ±10 microsecond samples.
    if(model==='woman')assert(maxDelta(at('pushups',0.0030406969288984936-1e-5),at('pushups',0.0030406969288984936+1e-5))<=.001,'crossing the support-fit threshold preserves whole-pose continuity');
    // Only nonpenetration is required while entering/getting up: hands can leave support naturally.
    for(const activity of ['pushups','idle'])for(const age of [0,.3,.6,.9])at(activity,age+(activity==='idle'?4:0),age);
    for(const offset of [0,.4,.9,5/3,2.5])assert(maxDelta(at('pushups',offset-1e-5),at('pushups',offset+1e-5))<=.001,'tiny phase changes retain whole-pose continuity');
    for(const activity of ['pushups','idle'])for(const end of [.6,.9])assert(maxDelta(at(activity,end-1e-5,end-1e-5),at(activity,end+1e-5,end+1e-5))<=.001,'entry/exit boundaries retain whole-pose continuity');
    const cold=fresh(),sequential=fresh();try{
      cold.setFrame([frame(model,'pushups')],clock+.4);cold.render(1);
      for(const offset of [0,.2,.4]){sequential.setFrame([frame(model,'pushups')],clock+offset);sequential.render(1);}
      const a=cold.bodyObject(id)!,b=sequential.bodyObject(id)!;a.updateMatrixWorld(true);b.updateMatrixWorld(true);
      assert(maxDelta(points(a,true),points(b,true))<=1e-5,'independent cold and sequential indexed geometry agree');
      for(const name of ['UpperArm','LowerArm','Wrist','UpperLeg','LowerLeg','Foot'])for(const side of ['L','R'])assert(a.getObjectByName(name+side)!.getWorldPosition(new THREE.Vector3()).distanceTo(b.getObjectByName(name+side)!.getWorldPosition(new THREE.Vector3()))<=1e-5,'independent cold and sequential endpoints agree');
    }finally{cold.clear();sequential.clear();}
    const hands={left:[1.2,1.2,-.35]as[number,number,number],right:[1.2,1.2,.35]as[number,number,number]};views.setFrame([{...frame(model,'pushups'),yaw:0,hands}],clock);views.render(1);
    for(const side of ['left','right']as const){const p=new THREE.Vector3();assert(views.palmOf(id,side,p));assert(p.distanceTo(new THREE.Vector3(...hands[side]))<=.001,'native hand target wins');}
    assert.deepEqual(views.bodyObject(id)!.position.toArray(),[1,0,0],'native hands keep the free floor layout off');
  }}finally{views.clear();setHumanGround(null);}
});
