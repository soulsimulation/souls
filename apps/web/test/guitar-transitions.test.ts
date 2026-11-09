import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import * as THREE from 'three';import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanViews,type SampledHuman} from '../../../mars/viewer/app/engine-view/humans.ts';import {templateFromGltf,type Template} from '../../../mars/viewer/app/engine-view/people.ts';import {CHARACTER_WIRE} from '../../../mars/viewer/app/engine-view/character-wire.ts';
import {TakePeople} from '../../../mars/viewer/app/engine-view/take-replay.ts';import {Runtime} from '../../../mars/viewer/engine/runtime/runtime.ts';import {Spatial} from '../../../mars/viewer/engine/spatial/service.ts';import {emptyWorld,human} from '../../../mars/viewer/engine/world/factory.ts';import {TakeRecorder} from '../../../mars/viewer/engine/take/recorder.ts';import {openGround} from '../../../mars/viewer/engine/test/frame-fixtures.ts';
import {assertGuitarGeometry} from './guitar-geometry.mjs';
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
for(const rig of ['casual','woman'] as const)for(const height of [1.65,1.85])for(const yaw of [0,1.7])test(`guitar actual rig ${rig},${height}m,yaw${yaw}: distal skin contacts strings and whole limbs clear solids while instrument stays fixed`,async()=>{
 const v=await views(rig,height);let matrix:number[]|undefined,maxError=0;
 for(let k=0;k<45;k++){
  const t=100+k*DT;v.setFrame([{id:ID,p:[3,.94,2],yaw,walk:0,walkDist:0,activity:'play-music',baseActivity:'idle',instrument:'guitar',activityAge:4}],t);v.render(1);
  const holder=(v as unknown as {views:Map<string,{rig:{holder:THREE.Object3D}}>}).views.get(ID)!.rig.holder;holder.updateMatrixWorld(true);const prop=holder.getObjectByName('activity prop: guitar')!;assert.ok(prop?.visible);
  if(matrix)assert.ok(prop.matrixWorld.elements.every((x,i)=>Math.abs(x-matrix![i])<1e-9),'guitar stays on torso while wrists move');matrix=[...prop.matrixWorld.elements];
  const diag=v.bones(ID)[ID];assert.equal(diag.guitar,undefined,'supported rig has no local pose failure');
  for(const arm of diag.arms){assert.ok(arm.target&&arm.err!==null&&Number.isFinite(arm.err)&&arm.ratio!==null&&Number.isFinite(arm.ratio),'genuine solver goal and finite reach diagnostics');maxError=Math.max(maxError,arm.err);assert.ok(arm.ratio<.98,'no arm stretching');}
  const view=(v as unknown as {views:Map<string,unknown>}).views.get(ID)!;
  assertGuitarGeometry(view,{contact:k%10===0});
 }
 assert.ok(maxError<.015,'actual palms attain genuine solver goals');
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

for(const entryRest of [.05,.4])for(const duration of [.1,.4,4])test(`guitar from restarted idle ${entryRest}s, stop ${duration}s: continuous observed underlay`,async()=>{
 const v=await views();let previous:number[][]|undefined,maxStep=0;
 for(let k=-1;k<=Math.round((duration+1.2)/DT);k++){
  const age=k*DT,active=k>=0&&age<duration-1e-8,released=age>=duration-1e-8;
  const f:SampledHuman={id:ID,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:active?'play-music':'idle',restAge:active?0:released?Math.max(0,age-duration):Math.max(0,entryRest+age),guitarEntryRestAge:entryRest,...(active?{instrument:'guitar',activityAge:age}:released?{activityAge:Math.max(0,age-duration),prevActivity:'play-music',prevInstrument:'guitar',prevActivityDuration:duration}:{})};
  v.setFrame([f],100+age);v.render(1);const p=palms(v);if(previous)for(let i=0;i<2;i++)maxStep=Math.max(maxStep,distance(previous[i],p[i]));previous=p;
  if(k>=0&&k%3===0){const fresh=await views();fresh.setFrame([f],100+age);fresh.render(1);assert.ok(p.every((p,i)=>distance(p,palms(fresh)[i])<1e-6),'fresh entry/release matches sequential');}
 }
 assert.ok(maxStep<=.08,`restarted idle path ${maxStep} m per50ms`);
});
async function shortChunks(){
 const scene=openGround(),world=emptyWorld('guitar-short-history',scene),e=human(ID,0,0);world.entities[ID]=e;
 e.human!.activity='read';const rt=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),all=new TakeRecorder(rt,{rulesVersion:'guitar-short-history'});let rec=new TakeRecorder(rt,{rulesVersion:'guitar-short-history'});const chunks:ReturnType<TakeRecorder['finish']>[]=[];
 for(let k=0;k<60;k++){
  if(k===10)e.human!.activity='idle';
  if(k===14){e.human!.activity='play-music';e.human!.instrument='guitar';}
  if(k===22){e.human!.activity='idle';delete e.human!.instrument;}
  rt.step();if((k+1)%2===0){chunks.push(rec.finish());if(k<59)rec=new TakeRecorder(rt,{rulesVersion:'guitar-short-history'});}
 }
 return {take:all.finish(),chunks};
}
test('short actual chunks retain new idle entry and full idle recovery over repeated/backwards seeks',async()=>{
 const {take,chunks}=await shortChunks(),tpl=await template('woman',1.75),whole=new TakePeople(take),part=new TakePeople(chunks[0]);whole.setTemplates([tpl]);part.setTemplates([tpl]);
 // The approved projection starts at guitar entry; generic earlier idle seeks retain their existing index.
 const order=[...Array.from({length:41},(_,i)=>i+15),45,25,15,23,47,23,15,45,47];
 for(const k of order){
  const c=chunks.find(c=>k>=c.startTick&&k<c.startTick+c.ticks)!;whole.show(k*DT);part.setTake(c);part.setWaterHistory(chunks);part.show((k-c.startTick)*DT,k*DT);
  const a=whole.bones(ID)[ID].arms;assert.ok(a.every((a,i)=>distance(a.palm,part.bones(ID)[ID].arms[i].palm)<.0003),`short chunks agree tick${k}`);
  const fresh=new TakePeople(c);fresh.setTemplates([tpl]);fresh.setWaterHistory(chunks);fresh.show((k-c.startTick)*DT,k*DT);assert.ok(a.every((a,i)=>distance(a.palm,fresh.bones(ID)[ID].arms[i].palm)<.0003),`fresh short chunk tick${k}`);
 }
});
for(const boundary of ['missing','foreign','ambiguous'] as const)test(`guitar observation stops at ${boundary} history boundary`,async()=>{
 const {chunks}=await shortChunks(),tpl=await template('woman',1.75);
 // Both the active and recovered-idle window start after their transitions.
 for(const index of [9,13]){
  const c=chunks[index],prev=chunks[index-1],history=boundary==='missing'?[]:boundary==='foreign'?[{...prev,rulesVersion:'foreign'}]:[prev,{...prev,id:prev.id+'-ambiguous'}];
  const bare=new TakePeople(c),p=new TakePeople(c);bare.setTemplates([tpl]);p.setTemplates([tpl]);p.setWaterHistory(history);
  for(const local of [DT,0,DT,DT]){
   bare.show(local);p.show(local);assert.ok(bare.bones(ID)[ID].arms.every((a,i)=>distance(a.palm,p.bones(ID)[ID].arms[i].palm)<1e-6),`${boundary} cannot certify a guitar transition`);
  }
 }
});
test('native recorded hand points take ownership during guitar idle recovery',async()=>{
 const scene=openGround(),world=emptyWorld('guitar-hands',scene),e=human(ID,0,0);world.entities[ID]=e;
 const rt=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),rec=new TakeRecorder(rt,{rulesVersion:'guitar-hands'});
 for(let k=0;k<40;k++){if(k===10){e.human!.activity='play-music';e.human!.instrument='guitar';}if(k===14){e.human!.activity='idle';delete e.human!.instrument;e.human!.hands={left:[.2,1.2,-.25],right:[.2,1.2,.25]};}rt.step();}
 const p=new TakePeople(rec.finish());p.setTemplates([await template('woman',1.75)]);p.show(.65);p.show(.8);
 const arms=p.bones(ID)[ID].arms;assert.ok(arms.every(a=>a.source==='hands'),'recorded hand points own both targets');
 const holder=(p as unknown as {humans:{views:Map<string,{rig:{holder:THREE.Object3D}}>}}).humans.views.get(ID)!.rig.holder;
 assert.equal(holder.getObjectByName('activity prop: guitar')?.visible??false,false,'native hand ownership hides guitar');
});

const guitarVisible=(v:HumanViews)=>((v as unknown as {views:Map<string,{rig:{holder:THREE.Object3D}}>}).views.get(ID)?.rig.holder.getObjectByName('activity prop: guitar')?.visible??false);
async function ownerRecording(owner:boolean,seat:'none'|'existing'|'new'='none'){
 const scene=openGround(),world=emptyWorld('guitar-owner-return',scene),e=human(ID,0,0);world.entities[ID]=e;if(seat==='existing')e.human!.on='supporting-seat';
 const rt=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),all=new TakeRecorder(rt,{rulesVersion:'guitar-owner-return'});let rec=new TakeRecorder(rt,{rulesVersion:'guitar-owner-return'});const chunks:ReturnType<TakeRecorder['finish']>[]=[],live=await views(),joined=await views(),liveStates=new Map<number,boolean>(),joinedStates=new Map<number,boolean>();live.onTick(world);live.render(1);
 for(let k=0;k<50;k++){
  if(k===10||k===24){e.human!.activity='play-music';e.human!.instrument='guitar';}
  if(k===14||k===28){e.human!.activity='idle';delete e.human!.instrument;}
  if(owner&&k===16)e.human!.hands={left:[.2,1.2,-.25],right:[.2,1.2,.25]};
  if(seat==='new'&&k===16)e.human!.on='new-seat';
  if(k===18){delete e.human!.hands;delete e.human!.on;}
  rt.step();live.onTick(world);live.render(1);liveStates.set(world.tick,guitarVisible(live));
  if(world.tick>=12){joined.onTick(world);joined.render(1);joinedStates.set(world.tick,guitarVisible(joined));}
  if((k+1)%2===0){chunks.push(rec.finish());if(k<49)rec=new TakeRecorder(rt,{rulesVersion:'guitar-owner-return'});}
 }
 return {take:all.finish(),chunks,liveStates,joinedStates};
}
for(const owner of [false,true])test(`new native hand owner stays cleared after release, next guitar resets: owner=${owner}`,async()=>{
 const {take,chunks,liveStates,joinedStates}=await ownerRecording(owner),tpl=await template('woman',1.75),whole=new TakePeople(take),part=new TakePeople(chunks[0]);whole.setTemplates([tpl]);part.setTemplates([tpl]);
 for(const tick of [16,17,18,19,20,21,22,26,30,35]){
  const expected=!owner||tick<17||tick>=25;
  assert.equal(liveStates.get(tick),expected,`native live tick${tick}`);assert.equal(joinedStates.get(tick),expected,`joined active live tick${tick}`);
 }
 for(const tick of [14,16,17,18,19,20,21,17,20,20,26,30,20,30,35]){
  const c=chunks.find(c=>tick>=c.startTick&&tick<c.startTick+c.ticks)!,expected=!owner||tick<17||tick>=25;
  whole.show(tick*DT);part.setTake(c);part.setWaterHistory(chunks);part.show((tick-c.startTick)*DT,tick*DT);
  const fresh=new TakePeople(c);fresh.setTemplates([tpl]);fresh.setWaterHistory(chunks);fresh.show((tick-c.startTick)*DT,tick*DT);
  for(const [label,p]of [['whole',whole],['chunk',part],['fresh',fresh]] as const)assert.equal(guitarVisible((p as unknown as {humans:HumanViews}).humans),expected,`${label} tick${tick}`);
 }
});
for(const boundary of ['missing','foreign','ambiguous'] as const)test(`owner-active recording baseline cannot restore guitar across ${boundary} history`,async()=>{
 const {chunks}=await ownerRecording(true),tpl=await template('woman',1.75),c=chunks[10],cut=chunks[8];
 const history=chunks.filter(t=>t!==cut);if(boundary==='foreign')history.push({...cut,rulesVersion:'foreign'});if(boundary==='ambiguous')history.push(cut,{...cut,id:cut.id+'-ambiguous'});
 const p=new TakePeople(c);p.setTemplates([tpl]);p.setWaterHistory(history);
 for(const tick of [20,21,20,20]){p.show((tick-c.startTick)*DT,tick*DT);assert.equal(guitarVisible((p as unknown as {humans:HumanViews}).humans),false,'uncertified release hidden after owner baseline/clear');}
});
for(const seat of ['existing','new'] as const)test(`${seat} seat ownership: only a newer owner invalidates guitar release`,async()=>{
 const {take,chunks,liveStates}=await ownerRecording(false,seat),tpl=await template('woman',1.75),expected=seat==='existing';
 assert.equal(liveStates.get(20),expected,'live seat clear preserves only uninterrupted release');
 for(const tick of [20,21,20]){const c=chunks.find(c=>tick>=c.startTick&&tick<c.startTick+c.ticks)!;for(const t of [take,c]){const p=new TakePeople(t);p.setTemplates([tpl]);p.setWaterHistory(chunks);p.show((tick-t.startTick)*DT,tick*DT);assert.equal(guitarVisible((p as unknown as {humans:HumanViews}).humans),expected,'recorded seat baseline and later clear');}}
});
