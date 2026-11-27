import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {CHARACTER_WIRE,CHARACTER_CLIPS} from './character-wire.ts';
import {templateFromGltf,createRig} from './people.ts';
import {HumanViews,setHumanGround} from './humans.ts';

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
function legLengths(holder:THREE.Object3D) {
  return ['L','R'].flatMap(side=>{const p=['UpperLeg','LowerLeg','Foot'].map(part=>holder.getObjectByName(part+side)!.getWorldPosition(new THREE.Vector3()));return[p[0].distanceTo(p[1]),p[1].distanceTo(p[2])];});
}
const key=({bone,p}:{bone:string;p:THREE.Vector3})=>bone+':'+p.toArray().map(v=>v.toFixed(6)).join(',');

test('each anatomical foot stays supported when the idle pose crosses the body midline',async()=>{
  const templates=new Map(await Promise.all((['woman','casual']as const).map(async name=>[name,await template(name)]as const)));
  const views=new HumanViews();views.setTemplates([...templates.values()]);views.setBodyTemplates(templates);setHumanGround(()=>0);
  const clock=1795711581.25,id='floor-contact-body',observed=3.565105438232422;
  try{for(const model of ['woman','casual']as const){
    views.clear();const reference=createRig(templates.get(model)!);reference.holder.updateMatrixWorld(true);const lengths=legLengths(reference.holder);reference.mixer.stopAllAction();
    const at=(activity:string,age:number,yaw=3.1411853071795868)=>{
      views.setFrame([{id,p:[1,0,0],yaw,walk:0,walkDist:0,bodyModel:model,activity,activityAge:age,postureChange:{from:activity==='pushups'?'idle':'pushups',to:activity,age,fromAge:5}}],clock+(activity==='pushups'?age:5+age));views.render(1);
      const holder=views.bodyObject(id)!;holder.updateMatrixWorld(true);
      assert.equal(holder.position.x,1);assert.equal(holder.position.z,0);assert(holder.position.y>=0&&holder.position.y<=.061);
      legLengths(holder).forEach((length,i)=>assert(Math.abs(length-lengths[i])<1e-5,'anatomical segment length is unchanged'));
      return{holder,drawn:points(holder,true)};
    };
    for(const activity of ['pushups','idle'])for(const age of activity==='pushups'?[0,.3,.6,.9,2.1,observed]:[0,.3,.6,.9]){
      const {holder,drawn}=at(activity,age,age===2.1?0:3.1411853071795868),primitive=points(holder,false);
      assert.deepEqual(drawn.map(key).sort(),primitive.map(key).sort(),'indexed drawable and source skin agree');
      for(const side of ['L','R']){
        const foot=drawn.filter(p=>p.bone==='Foot'+side),leg=drawn.filter(p=>p.bone==='UpperLeg'+side||p.bone==='LowerLeg'+side);
        assert(foot.length>100&&leg.length>100,'both anatomical support sets are nonvacuous');
        const low=Math.min(...foot.map(p=>p.p.y));
        assert(low>=-.001,`${model} ${activity} ${age} ${side} foot penetrates ${low}m`);
        if(activity==='pushups'&&age>=.9)assert(low<=.025,`${model} ${side} foot floats ${low}m`);
        assert(Math.min(...leg.map(p=>p.p.y))>=-.001,`${model} ${activity} ${age} ${side} lower limb penetrates`);
      }
    }
    for(const activity of ['pushups','idle'])for(const end of [.6,.9]){
      const a=at(activity,end-1e-5).drawn,b=at(activity,end+1e-5).drawn;
      assert.equal(a.length,b.length);assert(Math.max(...a.map((p,i)=>p.p.distanceTo(b[i].p)))<.001,'entry/exit boundary is continuous');
    }
    const a=at('pushups',observed).drawn;at('pushups',2.1);const b=at('pushups',observed).drawn;
    assert(Math.max(...a.map((p,i)=>p.p.distanceTo(b[i].p)))<=1e-5,'fresh seek retains the same drawable pose');
    const hands={left:[1.2,1.2,-.35]as[number,number,number],right:[1.2,1.2,.35]as[number,number,number]};
    views.setFrame([{id,p:[1,0,0],yaw:0,walk:0,walkDist:0,bodyModel:model,activity:'pushups',activityAge:observed,hands}],clock+observed);views.render(1);
    for(const side of ['left','right']as const){const palm=new THREE.Vector3();assert(views.palmOf(id,side,palm));assert(palm.distanceTo(new THREE.Vector3(...hands[side]))<.001,'native hand target retains ownership');}
    assert.deepEqual(views.bodyObject(id)!.position.toArray(),[1,0,0],'native hands do not acquire a free plank layout');
  }}finally{views.clear();setHumanGround(null);}
});
