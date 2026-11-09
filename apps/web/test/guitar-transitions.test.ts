import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import * as THREE from 'three';import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanViews,type SampledHuman} from '../../../mars/viewer/app/engine-view/humans.ts';import {templateFromGltf,type Template} from '../../../mars/viewer/app/engine-view/people.ts';import {CHARACTER_WIRE} from '../../../mars/viewer/app/engine-view/character-wire.ts';
import {TakePeople} from '../../../mars/viewer/app/engine-view/take-replay.ts';import {Runtime} from '../../../mars/viewer/engine/runtime/runtime.ts';import {Spatial} from '../../../mars/viewer/engine/spatial/service.ts';import {emptyWorld,human} from '../../../mars/viewer/engine/world/factory.ts';import {TakeRecorder} from '../../../mars/viewer/engine/take/recorder.ts';import {openGround} from '../../../mars/viewer/engine/test/frame-fixtures.ts';
const ID='guitar_contact',DT=.05,templates=new Map<string,Template>();
async function glb(file:string){
 const source=readFileSync(new URL('../../../mars/viewer/public/modular/environment/'+file,import.meta.url)),len=source.readUInt32LE(12),j=JSON.parse(source.subarray(20,20+len).toString()),bin=source.subarray(20+len);
 j.materials=j.materials?.map(()=>({pbrMetallicRoughness:{baseColorFactor:[.5,.5,.5,1]}}));delete j.textures;delete j.images;delete j.samplers;
 let json=Buffer.from(JSON.stringify(j));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);const h=Buffer.from(source.subarray(0,20));h.writeUInt32LE(20+json.length+bin.length,8);h.writeUInt32LE(json.length,12);const b=Buffer.concat([h,json,bin]);return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
}
async function template(rig:'casual'|'woman',height:number){
 const key=rig+height;if(!templates.has(key)){const wire=CHARACTER_WIRE[rig],g=await glb(wire.mesh);g.animations=(await glb(wire.clips)).animations.map(c=>c.clone());g.scene.userData.humanoid={look:{height}};templates.set(key,templateFromGltf(key,g));}return templates.get(key)!;
}
async function views(rig:'casual'|'woman'='woman',height=1.75){const v=new HumanViews();v.setTemplates([await template(rig,height)]);return v;}
const palms=(v:HumanViews)=>v.bones(ID)[ID].arms.map(a=>a.palm);
const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
for(const rig of ['casual','woman'] as const)for(const height of [1.65,1.85])for(const yaw of [0,1.7])test(`guitar actual rig ${rig},${height}m,yaw${yaw}: palms reach neck/strings while instrument stays fixed`,async()=>{
 const v=await views(rig,height);let matrix:number[]|undefined,maxError=0;
 for(let k=0;k<45;k++){
  const t=100+k*DT;v.setFrame([{id:ID,p:[3,.94,2],yaw,walk:0,walkDist:0,activity:'play-music',baseActivity:'idle',instrument:'guitar',activityAge:4}],t);v.render(1);
  const holder=(v as unknown as {views:Map<string,{rig:{holder:THREE.Object3D}}>}).views.get(ID)!.rig.holder;holder.updateMatrixWorld(true);const prop=holder.getObjectByName('activity prop: guitar')!;assert.ok(prop?.visible);
  if(matrix)assert.ok(prop.matrixWorld.elements.every((x,i)=>Math.abs(x-matrix![i])<1e-9),'guitar stays on torso while wrists move');matrix=[...prop.matrixWorld.elements];
  const arms=v.bones(ID)[ID].arms;for(const arm of arms){maxError=Math.max(maxError,arm.err??0);assert.ok((arm.ratio??0)<.98,'no arm stretching');const local=new THREE.Vector3(...arm.palm).applyMatrix4(prop.matrixWorld.clone().invert());assert.ok(Math.abs(local.x-(arm.side==='left'?.065:.075))<.015,'actual palm reaches drawn guitar face');if(arm.side==='left')assert.ok(local.y>.38&&local.y<.50&&Math.abs(local.z)<.015,'fretting hand remains on neck');else assert.ok(Math.abs(local.y-.04)<.015&&Math.abs(local.z)<.075,'strumming hand crosses actual strings');}
 }
 assert.ok(maxError<.015,'actual palms attain instrument contacts');
});
for(const duration of [.1,.4,4])test(`guitar entry and idle release ${duration}s: attained pose stays continuous, random access agrees`,async()=>{
 const v=await views(),end=100+duration;let previous:number[][]|undefined,maxStep=0,maxAt=0;let sample:{f:SampledHuman;t:number;palms:number[][]}|undefined;
 for(let k=-10;k<=Math.round((duration+1.2)/DT);k++){
  const t=100+k*DT,active=k>=0&&t<end-1e-8,after=t>=end-1e-8;
  const f:SampledHuman={id:ID,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:active?'play-music':'idle',...(active?{baseActivity:'idle',instrument:'guitar',activityAge:k*DT,prevActivity:'idle'}:after?{activityAge:Math.max(0,t-end),prevActivity:'play-music',prevBaseActivity:'idle',prevActivityDuration:duration,prevInstrument:'guitar'}:{activityAge:0})};
  v.setFrame([f],t);v.render(1);const p=palms(v);if(previous)for(let i=0;i<2;i++){const d=distance(previous[i],p[i]);if(d>maxStep){maxStep=d;maxAt=t-100;}};previous=p;if(Math.abs(t-end-.15)<.001)sample={f,t,palms:p};
 }
 console.log(JSON.stringify({duration,maxStep,maxAt}));assert.ok(maxStep<=.08,`attained guitar path ${maxStep} m per50ms`);assert.ok(sample);const fresh=await views();fresh.setFrame([sample.f],sample.t);fresh.render(1);assert.ok(palms(fresh).every((p,i)=>distance(p,sample.palms[i])<1e-6),'fresh release seek matches sequential');
});
test('recorded guitar release retains duration and instrument while unrelated drums keep no instrument history',async()=>{
 for(const instrument of ['guitar','drums']){
  const scene=openGround(),world=emptyWorld('guitar-history',scene),e=human(ID,0,0);world.entities[ID]=e;const rt=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),rec=new TakeRecorder(rt,{rulesVersion:'guitar-history'});
  for(let k=0;k<50;k++){if(k===20){e.human!.activity='play-music';e.human!.baseActivity='idle';e.human!.instrument=instrument;}if(k===24){e.human!.activity='idle';delete e.human!.baseActivity;delete e.human!.instrument;}rt.step();}
  const take=rec.finish(),people=new TakePeople(take);people.setTemplates([await template('woman',1.75)]);people.show(26*DT);
  const state=(people as unknown as {humans:{views:Map<string,{prevInstrument?:string;prevDuration?:number}>};acts:Map<string,{it?:number[]}>});
  if(instrument==='guitar'){assert.equal(state.humans.views.get(ID)?.prevInstrument,'guitar');assert.ok(Math.abs(state.humans.views.get(ID)!.prevDuration!-.2)<1e-8);const fresh=new TakePeople(take);fresh.setTemplates([await template('woman',1.75)]);fresh.show(26*DT);assert.deepEqual(fresh.bones(ID)[ID].arms.map(a=>a.palm),people.bones(ID)[ID].arms.map(a=>a.palm));}
  else{assert.equal(state.acts.get(ID)?.it,undefined);assert.equal(state.humans.views.get(ID)?.prevInstrument,undefined);}
 }
});
for(const duration of [.1,.35,1])test(`recorded guitar ${duration}s across real take chunks: sequential and fresh seeks agree`,async()=>{
 const scene=openGround(),world=emptyWorld('guitar-chunks',scene),e=human(ID,0,0);world.entities[ID]=e;const rt=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),all=new TakeRecorder(rt,{rulesVersion:'guitar-chunks'});let rec=new TakeRecorder(rt,{rulesVersion:'guitar-chunks'});const chunks:ReturnType<TakeRecorder['finish']>[]=[];
 const start=17,end=start+Math.round(duration/DT);
 for(let k=0;k<80;k++){if(k===start){e.human!.activity='play-music';e.human!.baseActivity='idle';e.human!.instrument='guitar';}if(k===end){e.human!.activity='idle';delete e.human!.baseActivity;delete e.human!.instrument;}rt.step();if((k+1)%20===0){chunks.push(rec.finish());if(k<79)rec=new TakeRecorder(rt,{rulesVersion:'guitar-chunks'});}}
 const take=all.finish(),tpl=await template('woman',1.75),whole=new TakePeople(take),part=new TakePeople(chunks[0]);whole.setTemplates([tpl]);part.setTemplates([tpl]);
 for(let k=12;k<65;k++){
  const c=chunks.find(c=>k>=c.startTick&&k<=c.startTick+c.ticks)!;whole.show(k*DT);part.setTake(c);part.setWaterHistory(chunks);part.show((k-c.startTick)*DT,k*DT);const a=whole.bones(ID)[ID].arms.map(a=>a.palm),b=part.bones(ID)[ID].arms.map(a=>a.palm);
  assert.ok(a.every((p,i)=>distance(p,b[i])<.0003),`recorded whole and adjacent chunks agree at tick${k}`);
  if(k%3===0){const fresh=new TakePeople(c);fresh.setTemplates([tpl]);fresh.setWaterHistory(chunks);fresh.show((k-c.startTick)*DT,k*DT);assert.ok(a.every((p,i)=>distance(p,fresh.bones(ID)[ID].arms[i].palm)<.0003),`fresh chunk seek at tick${k} equals sequential`);}
 }
});
test('a real recorded read after guitar keeps its book pose and immediately relinquishes the guitar prop',async()=>{
 const scene=openGround(),world=emptyWorld('guitar-read',scene),e=human(ID,0,0);world.entities[ID]=e;const rt=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),rec=new TakeRecorder(rt,{rulesVersion:'guitar-read'});
 for(let k=0;k<50;k++){if(k===10){e.human!.activity='play-music';e.human!.baseActivity='idle';e.human!.instrument='guitar';}if(k===30){e.human!.activity='read';delete e.human!.baseActivity;delete e.human!.instrument;}rt.step();}
 const p=new TakePeople(rec.finish());p.setTemplates([await template('woman',1.75)]);p.show(1.4);p.show(1.55);const state=p as unknown as {humans:{views:Map<string,{rig:{holder:THREE.Object3D}}>}};const holder=state.humans.views.get(ID)!.rig.holder;
 assert.equal(holder.getObjectByName('activity prop: guitar')?.visible??false,false,'new read owns its hands');assert.equal(holder.getObjectByName('activity prop: book')?.visible,true,'book is visible');
});
