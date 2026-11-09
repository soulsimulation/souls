import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanViews} from '../../../mars/viewer/app/engine-view/humans.ts';
import {templateFromGltf} from '../../../mars/viewer/app/engine-view/people.ts';
import {CHARACTER_WIRE} from '../../../mars/viewer/app/engine-view/character-wire.ts';
import {HumanoidKit} from '../src/humanoid/compose.ts';
import {guitarStrums,guitarFret,GUITAR_FADE} from '../../../mars/viewer/app/engine-view/piano-score.ts';
import {guitarPose,placeGuitar,poseGuitarHand} from '../../../mars/viewer/app/engine-view/guitar-contact.ts';
import {makeProp} from '../../../mars/viewer/app/engine-view/activity-poses.ts';
import {geometry,topology,skin,collisions,fingertipDistances,controls} from './guitar-geometry.mjs';

// Neutral deterministic fixture. Appearance reproduces the composed rig that exposed the defect.
const ID='guitar_contact',HZ=120,ROOT=new URL('../../../',import.meta.url),V=()=>new THREE.Vector3();
const look={face:'suit',hair:'beach',top:'swat',bottom:'king',shoes:'swat',headSize:1.015,height:1.76,
 skin:'#a8683f',hair1:'#a8743f',brows:'#865d32',eyes:'#4a3020',top1:'#f0eee6',top2:'#356477',bottom1:'#2a2a2e',shoes1:'#2c3538',soles:'#6b5a48',accent:'#c5a154',gear:'#3a3a3a'};
const templates=new Map();
async function glb(file){
 const source=readFileSync(new URL('mars/viewer/public/modular/environment/'+file,ROOT)),len=source.readUInt32LE(12),j=JSON.parse(source.subarray(20,20+len).toString()),bin=source.subarray(20+len);
 j.materials=j.materials?.map(()=>({pbrMetallicRoughness:{baseColorFactor:[.5,.5,.5,1]}}));delete j.textures;delete j.images;delete j.samplers;
 let json=Buffer.from(JSON.stringify(j));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);const h=Buffer.from(source.subarray(0,20));h.writeUInt32LE(20+json.length+bin.length,8);h.writeUInt32LE(json.length,12);const b=Buffer.concat([h,json,bin]);return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
}
const kit=new HumanoidKit(new GLTFLoader(),'/modular/humanoid/',async url=>{const b=readFileSync(new URL('mars/viewer/public'+url,ROOT));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);});
async function template(rig='composed',height=1.76){
 const key=rig+height;if(!templates.has(key)){
  if(rig==='composed')templates.set(key,await kit.template(look));
  else{const wire=CHARACTER_WIRE[rig],g=await glb(wire.mesh);g.animations=(await glb(wire.clips)).animations.map(c=>c.clone());g.scene.userData.humanoid={look:{height}};templates.set(key,templateFromGltf(key,g));}
 }return templates.get(key);
}
async function views(rig,height){const v=new HumanViews();v.setTemplates([await template(rig,height)]);return v;}
function state(stage,tau,id=ID){
 const released=stage==='release'||stage.startsWith('cancel'),f={id,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:released?'idle':'play-music',baseActivity:'idle',instrument:'guitar',activityAge:stage==='steady'?4:tau};
 if(released){delete f.instrument;Object.assign(f,{prevActivity:'play-music',prevBaseActivity:'idle',prevInstrument:'guitar',prevActivityDuration:stage.startsWith('cancel')?Number(stage.split('-')[1]):4});}return f;
}
function rendered(v,stage,tau,t=100+tau){
 v.setFrame([state(stage,tau)],t);v.render(1);const view=v.views.get(ID);view.rig.holder.updateMatrixWorld(true);const prop=view.rig.holder.getObjectByName('activity prop: guitar');
 return prop?.visible?{view,prop,scale:view.rig.template.bodyScale??1}:null;
}
function assertReach(v,frame){
 const diag=v.bones(ID)[ID];assert.equal(diag.guitar,undefined,'qualified geometry has no local failure');
 for(const a of diag.arms){
  assert.ok(a.target&&Number.isFinite(a.err)&&a.err!==null&&Number.isFinite(a.ratio)&&a.ratio!==null,'nonnull genuine goal and finite diagnostics');assert.ok(a.err<.015,'genuine palm goal error below15mm');assert.ok(a.ratio<.98,'shoulder/palm reach below.98');
  const arm=frame.view.arms.find(x=>(x.side>0?'left':'right')===a.side),shoulder=arm.upper.getWorldPosition(V()),elbow=arm.lower.getWorldPosition(V()),wrist=arm.hand.getWorldPosition(V()),length=shoulder.distanceTo(elbow)+elbow.distanceTo(wrist);
  const offset=arm.palmLocal.clone().multiply(arm.hand.getWorldScale(V())).applyQuaternion(arm.hand.getWorldQuaternion(new THREE.Quaternion()));
  const requestedWrist=new THREE.Vector3(...a.target).sub(offset);
  assert.ok(shoulder.distanceTo(requestedWrist)/length<.98,'genuine requested wrist inside physical reach ball');assert.ok(shoulder.distanceTo(wrist)/length<.98,'attained wrist without arm stretch');
 }
}
const panel=[['composed',1.76],...['casual','woman','punk'].flatMap(r=>[1.65,1.85].map(h=>[r,h]))];
for(const [rig,height]of panel)test(`${rig} ${height}m:120Hz solid clearance, full four-chord cycle, genuine reach and bilateral skin/string contact`,async()=>{
 const v=await views(rig,height);let refs,geo,maxError=0,total=0;const frets=new Set(),chords=new Set(guitarStrums(ID,100,108).map(s=>s.chord));
 assert.deepEqual([...chords].sort(),['Am','C','F','G'],'actual clock exercises all four chords');
 for(const stage of ['steady','entry','release','cancel-.1','cancel-.35','cancel-.7']){
  const duration=stage==='steady'?8:Math.max(1.2,GUITAR_FADE+.1);
  for(let k=0;k<=Math.round(duration*HZ);k++){
   const tau=k/HZ,frame=rendered(v,stage,tau);if(!frame)continue;refs??=topology(frame.view);geo??=geometry(frame.prop);assertReach(v,frame);
   const c=collisions(skin(refs,frame.prop.matrixWorld.clone().invert()),geo.solids,.001/frame.scale);
   assert.equal(c.triangleHits,0,`${stage} @${tau}: ${JSON.stringify(c.worst)}`);total++;
   for(const a of v.bones(ID)[ID].arms)maxError=Math.max(maxError,a.err);
   if(stage==='steady')frets.add(Math.round(guitarFret(ID,100+tau)*100));
  }
 }
 for(const fret of [40,43,46,48])assert.ok(frets.has(fret),`fret${fret} covered`);
 // Actual audible rake note times; nearest actual string, no invented pick or palm contact.
 for(const s of guitarStrums(ID,100,108))for(const i of s.notes.keys()){
  const frame=rendered(v,'steady',4,s.t+i*.008),inv=frame.prop.matrixWorld.clone().invert();
  for(const side of ['L','R']){const ds=fingertipDistances(skin(topology(frame.view,side),inv),geo.strings);assert.ok(Math.min(...ds.map(d=>d.distance*frame.scale))<=.003,`${side} distal skin contacts drawn strings at actual note time`);}
 }
 // The fretting hand remains on actual strings through each .18s chord transition.
 for(const boundary of [102,104,106,108])for(let k=0;k<=22;k++){
  const frame=rendered(v,'steady',4,boundary-k/HZ),ds=fingertipDistances(skin(topology(frame.view,'L'),frame.prop.matrixWorld.clone().invert()),geo.strings);
  assert.ok(Math.min(...ds.map(d=>d.distance*frame.scale))<=.003,'left physical neck/string contact through chord transition');
 }
 console.log(JSON.stringify({rig,height,total,maxGoalError:maxError,hz:HZ,solidTolerance:.001,contactTolerance:.003}));
});
test('independent solid/string oracle detects inside, edge and enclosing-triangle collisions and20mm contact gaps',()=>{
 const g=geometry(makeProp('guitar'));assert.equal(controls(g.solids,g.strings).length,3);
});

for(const scale of [1.65/1.75,1,1.85/1.75])for(const yaw of [0,1.7])test(`full-size opaque guitar entry/release trajectory scale${scale} yaw${yaw}`,()=>{
 const p=makeProp('guitar'),origin=new THREE.Vector3(3,.94,2),fwd=new THREE.Vector3(Math.cos(yaw),0,Math.sin(yaw)),count=p.children.length,materials=[];p.traverse(o=>{if(o.isMesh)materials.push(...[o.material].flat());});
 const matrix=(age,release,duration,time=100)=>{const g=guitarPose(ID,time,age,release,duration);placeGuitar(p,origin,fwd,g,scale);assert.equal(p.children.length,count);assert.equal(p.visible,g.weight>0);assert.ok(materials.every(m=>m.opacity===1&&!m.transparent),'no opacity hiding');assert.ok(Math.abs(p.matrix.determinant()-scale**3)<1e-10,'constant full-size scale');return [...p.matrix.elements];};
 let held;for(const time of [100,100.5,102,104,106,108]){const m=matrix(4,undefined,undefined,time);if(held)assert.deepEqual(m,held,'score never drives instrument');held=m;}
 for(const duration of [.1,.35,.7,4]){
  assert.deepEqual(matrix(duration,0,duration),matrix(duration),'short cancellation starts at attained transform');
  for(const released of [false,true]){let previous;for(let k=0;k<=144;k++){const m=released?matrix(duration,k/HZ,duration):matrix(k/HZ),pos=new THREE.Vector3(m[12],m[13],m[14]);if(previous)assert.ok(pos.distanceTo(previous)<.006,'continuous instrument <=6mm per120Hz sample');previous=pos;assert.deepEqual(m.slice(0,12),held.slice(0,12),'no rotation/scale change');}}
  for(const release of [.6,.1,.3,.1,0,.7,.3]){const a=matrix(duration,release,duration),fresh=makeProp('guitar');placeGuitar(fresh,origin,fwd,guitarPose(ID,100,duration,release,duration),scale);assert.deepEqual([...fresh.matrix.elements],a,'fresh/backward/repeated transform');}
 }
});
