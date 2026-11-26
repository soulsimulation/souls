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


test('free floor transitions retain their body pose beneath independent gestures',async()=>{
 const templates=new Map(await Promise.all((['woman','casual']as const).map(async name=>[name,await template(name)]as const)));
 const fresh=()=>{const v=new HumanViews();v.setTemplates([...templates.values()]);v.setBodyTemplates(templates);return v;};
 const id='floor-transition-contact',clock=100;
 const person=(model:'woman'|'casual',from:string,to:string,age:number):SampledHuman=>({id,p:[1,0,0],yaw:Math.PI,walk:0,walkDist:0,bodyModel:model,activity:to,activityAge:age,...(to==='wave'?{waveSamples:[{age}],waveClock:clock+age}:{}),postureChange:{from,to,age,fromAge:5}});
 const draw=(v:HumanViews,h:SampledHuman,time:number)=>{v.setFrame([h],time);v.render(1);const root=v.bodyObject(id)!;root.updateMatrixWorld(true);return points(root,true);};
 setHumanGround(()=>0);try{for(const model of ['woman','casual']as const){const v=fresh();try{
   const floor:SampledHuman={id,p:[1,0,0],yaw:Math.PI,walk:0,walkDist:0,bodyModel:model,activity:'stargaze',activityAge:5};
   const start=draw(v,floor,clock),entered=draw(v,person(model,'stargaze','wave',1e-5),clock+1e-5);
   assert(maxDelta(start,entered)<=.001,'gesture admission does not replace the attained lying body with standing');
   for(const [from,to]of [['stargaze','wave'],['situps','clap'],['wave','situps']]as const){
    for(const age of [0,.02417185,.1,.25,.58239785,1.08558655,1.25,1.55,1.85]){
     const h=person(model,from,to,age),surface=draw(v,h,clock+age);
     assert.deepEqual(h.p,[1,0,0],'native root input remains unchanged');
     for(const side of ['L','R'])for(const kind of ['hand','foot']){
      const refs=surface.filter(p=>(kind==='hand'?/^(Wrist|Thumb|Index|Middle|Ring|Pinky)/:/^Foot/).test(p.bone)&&p.bone.endsWith(side));
      assert(refs.length>100,'both actual indexed contact sets are populated');
      const low=Math.min(...refs.map(p=>p.p.y));assert(low>=-.001,`${model} ${from}->${to} ${age} ${kind}${side} penetrates ${low}m`);
     }
    }
    for(const age of (from==='wave'?[0,.9,1.2,1.5]:[0,.25,1.25,1.55,1.85])){const a=draw(v,person(model,from,to,Math.max(0,age-1e-5)),clock+Math.max(0,age-1e-5)),b=draw(v,person(model,from,to,age+1e-5),clock+age+1e-5);assert(maxDelta(a,b)<=.001,`${from}->${to} phase${age} keeps whole-pose continuity`);}
   }
   const cold=fresh(),seq=fresh();try{const h=person(model,'stargaze','wave',.58239785),a=draw(cold,h,clock+.58239785);for(const age of [0,.1,.25,.4])draw(seq,person(model,'stargaze','wave',age),clock+age);assert(maxDelta(a,draw(seq,h,clock+.58239785))<=1e-5,'independent cold and sequential floor exit agree');}finally{cold.clear();seq.clear();}
   // Completion hands the same planted lower body from a free overlay to ordinary idle.
   const release=(age:number):SampledHuman=>({...person(model,'wave','idle',age),waveSamples:[{released:age,duration:2}],waveClock:clock+2+age,postureChange:{from:'wave',to:'idle',age,fromAge:2}});
   const before=draw(v,person(model,'idle','wave',2),clock+2),after=draw(v,release(1e-5),clock+2+1e-5);
   assert(maxDelta(before,after)<=.001,'wave completion retains the attained whole pose');
   for(const age of [0,.3,2]){const a=draw(v,release(Math.max(0,age-1e-5)),clock+2+Math.max(0,age-1e-5)),b=draw(v,release(age+1e-5),clock+2+age+1e-5);assert(maxDelta(a,b)<=.001,'wave release and idle support are continuous');for(const side of ['L','R'])assert(Math.min(...b.filter(p=>/^Foot/.test(p.bone)&&p.bone.endsWith(side)).map(p=>p.p.y))>=-.001,'idle handoff preserves support');}
   const hands={left:[1.2,1.2,-.35]as[number,number,number],right:[1.2,1.2,.35]as[number,number,number]};draw(v,{...person(model,'stargaze','wave',.58),hands,yaw:0},clock+.58);for(const side of ['left','right']as const){const p=new THREE.Vector3();assert(v.palmOf(id,side,p));assert(p.distanceTo(new THREE.Vector3(...hands[side]))<=.001,'native hand targets keep authority');}
 }finally{v.clear();}}}finally{setHumanGround(null);}
});

test('constructed production-rig seated wave retains its seat through entry and recovery',async()=>{
 const templates=new Map(await Promise.all((['woman','casual']as const).map(async name=>[name,await template(name)]as const)));
 const id='seated-wave-contact',clock=50,seat=.45;
 const fresh=()=>{const v=new HumanViews();v.setTemplates([...templates.values()]);v.setBodyTemplates(templates);return v;};
 const sample=(model:'woman'|'casual',activity:string,age:number,released?:number):SampledHuman=>({id,p:[1,0,0],yaw:.3,walk:0,walkDist:0,bodyModel:model,activity,baseActivity:'sit',seatHeight:seat,activityAge:age,...(released===undefined?activity==='wave'?{waveSamples:[{age}],waveClock:clock+age}:{}:{prevActivity:'wave',prevBaseActivity:'sit',prevWaveDuration:2,waveSamples:[{released,duration:2}],waveClock:clock+2+released})});
 const draw=(v:HumanViews,h:SampledHuman,time:number)=>{v.setFrame([h],time);v.render(1);const root=v.bodyObject(id)!;root.updateMatrixWorld(true);const state=(v as unknown as{views:Map<string,{seat:number;cur:{p:number[];sitW:number}} >}).views.get(id)!;assert.deepEqual(state.cur.p,[1,0,0],'stored native root is authoritative');assert.equal(state.seat,seat,'actual seated height remains native');assert.equal(state.cur.sitW,1,'seated support remains active');const skin=points(root,true);for(const side of ['L','R']){const foot=skin.filter(p=>/^Foot/.test(p.bone)&&p.bone.endsWith(side));assert(foot.length>100);assert(Math.min(...foot.map(p=>p.p.y))>=-.001,h.bodyModel+' seated foot '+side+' penetrates');}return{skin,holder:root.position.clone(),pelvis:root.getObjectByName('Body')!.getWorldPosition(new THREE.Vector3())};};
 setHumanGround(()=>0);try{for(const model of ['woman','casual']as const){const v=fresh(),underlying=fresh();try{
  const at=(activity:string,age:number,time:number,released?:number)=>{const a=draw(v,sample(model,activity,age,released),time),base=draw(underlying,sample(model,'sit',5),time);assert(a.holder.distanceTo(base.holder)<=1e-5,'drawn holder retains underlying seat layout');assert(a.pelvis.distanceTo(base.pelvis)<=1e-5,'drawn pelvis retains underlying seat layout');return a.skin;};
  assert(maxDelta(at('sit',5,clock),at('wave',1e-5,clock+1e-5))<=.001,'seated wave admission is continuous');
  for(const age of [0,.3,1,2])at('wave',age,clock+age);
  assert(maxDelta(at('wave',2-1e-5,clock+2-1e-5),at('sit',1e-5,clock+2+1e-5,1e-5))<=.001,'seated wave completion retains attained pose');
  for(const age of [0,.3,1,2])at('sit',age,clock+2+age,age);
  assert(maxDelta(at('sit',2-1e-5,clock+4-1e-5,2-1e-5),at('sit',2+1e-5,clock+4+1e-5))<=.001,'seated wave returns continuously to underlying seat');
 }finally{v.clear();underlying.clear();}}}finally{setHumanGround(null);}
});
