import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {guitarStrums,guitarStroke,GUITAR_FADE} from '../../../mars/viewer/app/engine-view/piano-score.ts';
import {guitarPose,placeGuitar} from '../../../mars/viewer/app/engine-view/guitar-contact.ts';
import {activityFrame,makeProp} from '../../../mars/viewer/app/engine-view/activity-poses.ts';
import {GuitarAudio,guitarWave} from './gen-mesh/guitar.ts';
test('guitar score windows compose on the absolute piano clock and the pick crosses strings at every audible strum',()=>{
 const pieces=new Set<string>();
 for(const seed of ['h_a','h_b','h_c','h_d','h_e','h_f']){
  const all=guitarStrums(seed,100,108);pieces.add(JSON.stringify(all.map(s=>s.chord)));
  assert.deepEqual(all,guitarStrums(seed,100,103.17).concat(guitarStrums(seed,103.17,108)));
  for(const s of all){assert.equal(s.t% .5,0);assert.ok(Math.abs(guitarStroke(seed,s.t))<1e-8);assert.ok(s.notes.every(n=>n>=40&&n<=67));assert.ok(s.notes.length>=3&&s.notes.length<=6);}
  assert.notEqual(guitarStroke(seed,100.2),guitarStroke(seed,100.7),'down and up strokes alternate');
 }
 assert.ok(pieces.size>1,'body seed selects distinct harmonic progressions');
});
test('the drawn guitar stays still while authored distal contact goals track its neck and six strings, at multiple scales and yaws',()=>{
 const prop=makeProp('guitar'),origin=new THREE.Vector3(3,2,4),seed='h_a';
 const drawnStrings=prop.children.filter(o=>(o as THREE.Mesh).isMesh&&Math.abs(o.position.x-.058)<1e-8&&Math.abs(o.scale.z-.002)<1e-8) as THREE.Mesh[];
 const stringBoxes=drawnStrings.map(m=>{m.updateMatrix();m.geometry.computeBoundingBox();return m.geometry.boundingBox!.clone().applyMatrix4(m.matrix);});
 const stringFront=Math.max(...stringBoxes.map(b=>b.max.x));
 for(const scale of [.7,1,1.3])for(const yaw of [0,.7,2.3]){
  const fwd=new THREE.Vector3(Math.cos(yaw),0,Math.sin(yaw));let before:number[]|undefined;
  for(let t=100;t<104;t+=.025){
   const pose=guitarPose(seed,t,4),frame=activityFrame('play-music','idle',t,seed,{actorId:seed,instrument:'guitar',since:4})!;
   placeGuitar(prop,origin,fwd,pose,scale);assert.equal(prop.visible,true);
   if(before)assert.deepEqual(prop.matrix.elements,before,'strumming never moves the instrument');before=[...prop.matrix.elements];

   const handWorld=(p:readonly number[])=>origin.clone().addScaledVector(fwd,p[0]*scale).addScaledVector(new THREE.Vector3(-fwd.z,0,fwd.x),p[1]*scale).add(new THREE.Vector3(0,p[2]*scale,0));
   const left=handWorld(pose.left).applyMatrix4(prop.matrix.clone().invert()),right=handWorld(pose.right).applyMatrix4(prop.matrix.clone().invert());
   assert.ok(left.y>=.39&&left.y<=.49&&stringBoxes.some(b=>b.distanceToPoint(left)<1e-8),'authored fretting goal lies on an actual drawn string surface');
   assert.ok(Math.abs(right.y-.04)<1e-8&&Math.abs(right.z-left.z)<=.058001&&Math.abs(right.x-stringFront)<1e-8,'authored strum contact crosses the string bed, independent of guitar frame');
   assert.deepEqual(frame.rootHands?.[0],[pose.left[0],-pose.left[1],pose.left[2]]);
  }
 }
 const strings=prop.children.filter(o=>(o as THREE.Mesh).isMesh&&Math.abs(o.position.x-.058)<1e-8&&Math.abs(o.scale.z-.002)<1e-8);assert.equal(strings.length,6,'six actual drawn strings');
 assert.equal(guitarPose(seed,100,0).weight,0);assert.equal(guitarPose(seed,101,GUITAR_FADE).weight,1);assert.equal(guitarPose(seed,101,4,GUITAR_FADE).weight,0);
});
function audioFixture(){
 const starts:{at:number;stopped:boolean;buffer:any}[]=[],nodes:any[]=[];
 const out={};const ctx={sampleRate:8000,createBuffer:(_channels:number,length:number,rate:number)=>({sampleRate:rate,data:new Float32Array(length),copyToChannel(data:Float32Array){this.data.set(data);}}),createGain:()=>({gain:{value:0},connect:()=>out,disconnect(){}}),createBufferSource:()=>{const node={buffer:null as any,onended:null,connect:()=>({connect:()=>out}),disconnect(){},start(at:number){const rec={at,stopped:false,buffer:this.buffer};starts.push(rec);(this as any).rec=rec;},stop(){(this as any).rec.stopped=true;}};nodes.push(node);return node;}};
 return {ctx:ctx as unknown as AudioContext,out:out as AudioNode,starts,nodes};
}
test('live audio schedules only held in-range guitar, deduplicates windows and cancels every unstarted string',()=>{
 const f=audioFixture(),audio=new GuitarAudio(),resident={id:'a',body:'h_a',p:[0,0,0] as const,activityAge:0};
 const step=(now:number,age:number,gain=1,active=true,left?:number)=>{audio.begin(now,now-90);if(active)audio.resident({...resident,activityAge:age,activityLeft:left},gain,f.ctx,f.out);audio.finish();};
 step(100,0);assert.equal(f.starts.length,0,'silent until hands hold the instrument');
 step(101,.99,0);assert.equal(f.starts.length,0,'distant instrument allocates no audio');assert.equal(audio.state().cachedStrings,0);
 step(101,1);const count=f.starts.length;assert.ok(count>0);step(101.1,1.1);assert.equal(f.starts.length,count,'overlapping windows never repeat strums');
 step(101.3,1.3);const future=f.starts.filter(n=>n.at>11.3);assert.ok(future.length>0);
 step(101.31,1.31,0,false);assert.ok(future.every(n=>n.stopped),'all unstarted strings cancelled');
 for(let now=102;now<110;now+=.1)step(now,now-100,1,true,104-now);
 assert.ok(f.starts.every(n=>n.at<=14.05),'recorded end bounds the final rake');
 assert.ok(audio.state().pending<10);assert.ok(audio.state().cachedStrings<=16);
});
test('plucked string is deterministic, pitched and decays to silence rather than a sustained piano oscillator',()=>{
 const a=guitarWave(57,8000),b=guitarWave(57,8000);assert.deepEqual(a,b);
 const energy=(from:number,to:number)=>a.slice(from,to).reduce((s,x)=>s+x*x,0)/(to-from);
 assert.ok(energy(100,2000)>energy(a.length-2000,a.length)*8);assert.ok(a.every(Number.isFinite));assert.ok(a.some(x=>Math.abs(x)>.1));
});
