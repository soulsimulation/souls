import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {templateFromGltf} from './people.ts';
import {lastPostureChange} from './posture-transition.ts';
import {HumanViews, setHumanGround, type SampledHuman} from './humans.ts';

// Actual production geometry, skeleton and clips. Texture decoding is immaterial to skinned surface contact.
async function template() {
  const loader = new GLTFLoader();
  loader.register(() => ({name:'contact-test-material',loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const root = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
  const read = async (name:string) => { const b=await readFile(root+'/'+name);return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),''); };
  const mesh=await read('animated-casual.mesh.glb'), clips=await read('clips-ual.glb');
  mesh.animations=clips.animations;
  return templateFromGltf('casual',mesh);
}

test('actual rig plants both push-up feet throughout entry, repetitions and exit without moving the recorded root',async()=>{
  const views=new HumanViews(); const rigTemplate=await template();views.setTemplates([rigTemplate]); setHumanGround(()=>0);
  const sample=(time:number,activity:string,age:number,from:string)=>{
    const person:SampledHuman={id:'contact-rig',p:[1,0,0],yaw:0,walk:0,walkDist:0,activity,activityAge:age,postureChange:{from,to:activity,age}};
    views.setFrame([person],time);views.render(1);
    return views.meshPoints(person.id,1);
  };
  const metrics = () => {
    const out:Record<string,{n:number;min:number;max:number}>={};
    views.bodyObject('contact-rig')!.traverse(o=>{
      const m=o as THREE.SkinnedMesh;if(!m.isSkinnedMesh||m.userData.bodyDraw)return;
      const pos=m.geometry.getAttribute('position'),si=m.geometry.getAttribute('skinIndex'),sw=m.geometry.getAttribute('skinWeight');
      if(!si||!sw)return;
      const p=new THREE.Vector3();
      for(let i=0;i<pos.count;i++){
        let k=0;for(let j=1;j<4;j++)if(sw.getComponent(i,j)>sw.getComponent(i,k))k=j;
        const name=m.skeleton.bones[si.getComponent(i,k)]?.name??'';
        const part=/^(Foot|Toe)/.test(name)?'foot':/^(UpperLeg|LowerLeg)/.test(name)?'leg':/^(Wrist|Thumb|Index|Middle|Ring|Pinky)/.test(name)?'hand':null;
        if(!part)continue;const side=/L$/.test(name)?'L':/R$/.test(name)?'R':null;if(!side)continue;
        m.getVertexPosition(i,p).applyMatrix4(m.matrixWorld);const r=out[part+side]??={n:0,min:Infinity,max:-Infinity};r.n++;r.min=Math.min(r.min,p.y);r.max=Math.max(r.max,p.y);
      }
    });return out;
  };
  const check=(label:string,planted:boolean)=>{
    const rows=metrics();
    const root=views.bodyObject('contact-rig')!.position;if(!label.startsWith('back'))assert.ok(Math.abs(root.x-1)<1e-8&&Math.abs(root.z)<1e-8,'native horizontal placement is retained');
    if(!label.startsWith('back'))assert.ok(root.y>=-1e-8&&root.y<=.061,'only the bounded authored plank layout offset is applied');
    for(const side of ['L','R']){
      for(const part of ['foot','leg','hand'])assert.ok(rows[part+side]?.n>50,part+side+' is nonvacuous');
      assert.ok(rows['foot'+side].min>=-.015,`${label} ${side} foot penetration ${rows['foot'+side].min}`);
      assert.ok(rows['leg'+side].min>=-.015,`${label} ${side} leg penetration ${rows['leg'+side].min}`);
      assert.ok(rows['hand'+side].min>=-.015,`${label} ${side} hand penetration ${rows['hand'+side].min}`);
      if(planted){
        assert.ok(rows['foot'+side].min<=.025,`${label} ${side} floating ${rows['foot'+side].min}`);

      }
    }
  };
  for(let time=0;time<4;time+=.025){sample(time,'pushups',time,'idle');check('entry/repetitions '+time,time>=.6);}
  for(let age=0;age<1;age+=.025){sample(4+age,'idle',age,'pushups');check('exit '+age,false);}
  for(const activity of ['situps','stargaze']){
    for(let age=0;age<3;age+=.05){sample(10+age,activity,age,'idle');check('back entry '+activity+' '+age,false);}
    for(let age=0;age<1.7;age+=.05){sample(13+age,'idle',age,activity);check('back exit '+activity+' '+age,false);}
  }
  // Sampling the same time again after another time must not accumulate an IK/holder correction.
  const a=sample(1.2,'pushups',1.2,'idle'); sample(2.8,'pushups',2.8,'idle');
  const b=sample(1.2,'pushups',1.2,'idle');
  assert.equal(a.length,b.length);
  for(let i=0;i<a.length;i++)assert.ok(a[i].p.every((x,j)=>Math.abs(x-b[i].p[j])<1e-5),'surface evaluation is repeatable');
  const times=[0,1,1.35,1.42,1.5,1.53,2.2,2.25,3.8], acts=['idle','situps','idle','pushups','idle','situps','idle','pushups','idle'];
  const interrupted=(time:number)=>{
    let k=0;while(k+1<times.length&&times[k+1]<=time)k++;
    const pc=lastPostureChange(times,acts,k,time,1,()=>undefined);
    views.setFrame([{id:'contact-rig',p:[1,0,0],yaw:0,walk:0,walkDist:0,activity:acts[k],activityAge:time-times[k],...(acts[k]==='idle'?{restAge:time-times[k]}:{}),...(pc?{postureChange:pc}:{})}],time);views.render(1);
    return views.meshPoints('contact-rig',1);
  };
  for(const time of times.slice(1)){
    const before=interrupted(time-1e-5),after=interrupted(time+1e-5);
    let delta=0;for(let i=0;i<before.length;i++)delta=Math.max(delta,Math.hypot(...before[i].p.map((x,j)=>x-after[i].p[j])));
    assert.ok(delta<.015,`recorded interruption at ${time} moves surface ${delta}m`);
  }
  for(const [from,to,ends] of [
    ['idle','pushups',[.6,.9]],['pushups','idle',[.6,.9]],['idle','situps',[.9,1.2]],['situps','idle',[.25,1.25,1.55]],['pushups','situps',[.45,1,1.3]],['situps','pushups',[.25,.8,1.25]],
  ] as const){
    const at=(age:number)=>{views.setFrame([{id:'contact-rig',p:[1,0,0],yaw:0,walk:0,walkDist:0,activity:to,activityAge:age,...(to==='idle'?{restAge:age}:{}),postureChange:{from,to,age,fromAge:5}}],20+age);views.render(1);return views.meshPoints('contact-rig',1);};
    for(const end of ends){const a=at(end-1e-5),b=at(end+1e-5);let delta=0;for(let i=0;i<a.length;i++)delta=Math.max(delta,Math.hypot(...a[i].p.map((x,j)=>x-b[i].p[j])));assert.ok(delta<.015,`${from}->${to} phase ${end} moves surface ${delta}m`);}
  }
  const seated=(time:number,activity:string,age:number,released?:number)=>{views.setFrame([{id:'contact-rig',p:[1,0,0],yaw:0,walk:0,walkDist:0,activity,baseActivity:'sit',seatHeight:.45,activityAge:age,...(released===undefined?activity==='wave'?{waveSamples:[{age}]}:{}:{prevActivity:'wave',prevBaseActivity:'sit',prevWaveDuration:2,waveSamples:[{released,duration:2}]})}],time);views.render(1);return views.meshPoints('contact-rig',1);};
  const distance=(a:ReturnType<typeof seated>,b:ReturnType<typeof seated>)=>Math.max(...a.map((p,i)=>Math.hypot(...p.p.map((x,j)=>x-b[i].p[j]))));
  assert.ok(distance(seated(50,'sit',5),seated(50+1e-5,'wave',1e-5))<.015,'seated wave enters from actual seated pose');
  assert.ok(distance(seated(52-1e-5,'wave',2-1e-5),seated(52+1e-5,'sit',1e-5,1e-5))<.015,'seated wave release retains attained arm pose');
  assert.ok(distance(seated(55,'sit',3,3),seated(55,'sit',3))<.015,'seated wave returns to the seated library pose');
  seated(55,'sit',3);const seatRoot=views.bodyObject('contact-rig')!.position.clone();seated(55,'cheer',3);assert.ok(seatRoot.distanceTo(views.bodyObject('contact-rig')!.position)<1e-5,'a seated overlay cannot add a whole-body hop');
  const native=(p:[number,number,number],yaw:number)=>{views.setFrame([{id:'contact-rig',p,yaw,walk:0,walkDist:0,activity:'pushups',activityAge:.1,postureChange:{from:'idle',to:'pushups',age:.1,fromAge:3}}],60.1);views.render(1);return views.meshPoints('contact-rig',1);};
  const first=native([1,0,0],0);native([4,0,-2],1.2);assert.ok(distance(first,native([1,0,0],0))<1e-5,'native root/yaw changes do not seed a stale cached origin');
  const moving=(age:number,dx=0,dz=0,retainedIdle=false)=>{const time=70+age;views.setFrame([{id:'contact-rig',p:[1+age+dx,0,dz],yaw:0,walk:Math.min(1,age/.2),walkDist:age,activity:'walk',activityAge:age,postureChange:{from:'stargaze',to:retainedIdle?'idle':'walk',age,fromAge:5}}],time);views.render(1);assert.ok(Math.abs(views.bodyObject('contact-rig')!.position.x-(1+age+dx))<1.1,'only cosmetic layout offsets accompany the current root');return views.meshPoints('contact-rig',1);};
  const oldFloor=()=>{views.setFrame([{id:'contact-rig',p:[1,0,0],yaw:0,walk:0,walkDist:0,activity:'stargaze',activityAge:5}],70);views.render(1);return views.meshPoints('contact-rig',1);};
  assert.ok(distance(oldFloor(),moving(1e-5))<.015,'floor-to-motion starts from the actual drawn floor pose');
  const anchored=moving(.7),translated=moving(.7,3,2);const translationError=Math.max(...anchored.map((p,i)=>Math.hypot(translated[i].p[0]-p.p[0]-3,translated[i].p[1]-p.p[1],translated[i].p[2]-p.p[2]-2)));assert.ok(translationError<.0003,'current-root translation equivariance within meshPoints 0.1mm quantization: '+translationError);
  let priorHead=-Infinity;for(let age=0;age<1.5;age+=.025){const points=moving(age),head=Math.max(...points.filter(p=>p.part==='head').map(p=>p.p[1]));if(age>.3)assert.ok(head>=priorHead-.04,'moving get-up head dip at '+age+': '+priorHead+' -> '+head);priorHead=head;}
  assert.ok(distance(moving(1.25-1e-12),moving(1.25+1e-12))<.015,'a rise rounded to phase one holds the terminal clip frame rather than wrapping to lying');
  for(const end of [.25,1.25,1.55]){const a=moving(end-1e-5),b=moving(end+1e-5),d=distance(a,b);if(d>=.015){const i=a.findIndex((p,i)=>Math.hypot(...p.p.map((x,j)=>x-b[i].p[j]))===d);console.log('MOVING_PHASE',end,d,a[i],b[i]);}assert.ok(d<.015,'moving-root get-up phase '+end+' surface '+d+'m');}
  for(const end of [.25,1.25,1.55])assert.ok(distance(moving(end-1e-5,0,0,true),moving(end+1e-5,0,0,true))<.015,'short idle gap retains floor-to-motion phase continuity '+end);
  for(const walk of [.05,.103,.25,.49]){const p:[number,number,number]=[1.067,0,-.019];views.setFrame([{id:'contact-rig',p,yaw:-.274,walk,walkDist:.067,activity:'stargaze',activityAge:2.115}],82+walk);views.render(1);assert.deepEqual(p,[1.067,0,-.019],'native input root remains authoritative');const points=views.meshPoints('contact-rig',1);for(const part of ['leg','foot']){const skin=points.filter(x=>x.part===part);assert(skin.length>0);assert(Math.min(...skin.map(x=>x.p[1]))>=-.015,'free floor '+part+' remains above penetration tolerance while movement weight ramps '+walk);}}
  views.clear();setHumanGround(null);
});
