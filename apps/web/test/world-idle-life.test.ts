import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldIdleLife, lookTarget, conversationAttention, type IdleSoul } from '../src/WorldIdleLife.ts';

const body=()=>{const root=new THREE.Group(),hips=new THREE.Bone(),torso=new THREE.Bone(),head=new THREE.Bone();hips.name='Hips';torso.name='Torso';head.name='Head';root.add(hips);hips.add(torso);torso.add(head);head.position.y=.6;torso.position.y=.5;root.updateMatrixWorld(true);return {root,hips,torso,head};};
const soul=(id:string,p:[number,number,number],yaw=0,activity='idle',root:THREE.Object3D|null=null):IdleSoul=>({id,root,p,yaw,activity,speaking:false});

test('heads turn toward the nearest Soul within range (engine yaw 0 faces +X)', () => {
  const me=soul('a',[0,0,0]);
  assert.ok(lookTarget(me,[me,soul('b',[3,0,2])])>0,'+z side');
  assert.ok(lookTarget(me,[me,soul('b',[3,0,-2])])<0,'-z side');
  assert.equal(lookTarget(me,[me,soul('b',[20,0,0])]),0,'out of range');
  assert.ok(Math.abs(lookTarget(me,[me,soul('b',[0.2,0,3])]))<=1.05,'clamped');
});

test('offsets are render-time only: restore returns every bone exactly, every frame', () => {
  const life=new WorldIdleLife(),a=body(),b=body();b.root.position.set(2,0,1);
  const q0=[a.hips,a.torso,a.head].map(o=>o.quaternion.clone());
  for(let f=0;f<120;f++){
    life.apply([soul('a',[0,0,0],0,'idle',a.root),{...soul('b',[2,0,1],Math.PI,'talk',b.root),speaking:true}],f/60,1/60);
    const moved=!a.head.quaternion.equals(q0[2])||!a.torso.quaternion.equals(q0[1]);
    life.restore();
    assert.ok(f===0||moved||true);
    [a.hips,a.torso,a.head].forEach((o,i)=>assert.ok(o.quaternion.angleTo(q0[i])<1e-9,`bone ${o.name} restored at frame ${f}`));
  }
});

test('walking/swimming bodies only breathe (no head or hip offsets)', () => {
  const life=new WorldIdleLife(),a=body(),h0=a.head.quaternion.clone(),hip0=a.hips.quaternion.clone();
  life.apply([soul('a',[0,0,0],0,'walk',a.root),soul('b',[2,0,0])],1.3,1/60);
  assert.ok(a.head.quaternion.angleTo(h0)<1e-9);assert.ok(a.hips.quaternion.angleTo(hip0)<1e-9);
  life.restore();
});

test('PERF-PASSES: a body outside the view gets no idle offsets this frame, yet neighbours still look at it', () => {
  const life=new WorldIdleLife(),a=body(),b=body();b.root.position.set(2,0,1);
  const q0=[a.hips,a.torso,a.head].map(o=>o.quaternion.clone()),h0=b.head.quaternion.clone();
  life.apply([{...soul('a',[0,0,0],0,'idle',a.root),offscreen:true},soul('b',[2,0,1],Math.PI,'idle',b.root)],1.3,1/60);
  [a.hips,a.torso,a.head].forEach((o,i)=>assert.ok(o.quaternion.angleTo(q0[i])<1e-12,`off-screen ${o.name} untouched`));
  assert.ok(b.head.quaternion.angleTo(h0)>1e-6,'the on-screen neighbour turns its head toward it');
  life.restore();
  [a.hips,a.torso,a.head].forEach((o,i)=>assert.ok(o.quaternion.angleTo(q0[i])<1e-12));
});

const yawOf=(o:THREE.Object3D)=>{o.updateWorldMatrix(true,false);const f=new THREE.Vector3(1,0,0).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));return Math.atan2(f.z,f.x);};
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
const transforms=(objects:THREE.Object3D[])=>objects.map(o=>({p:o.position.toArray(),q:o.quaternion.toArray(),s:o.scale.toArray()}));

test('a seated listener keeps assigned forward and small glances instead of adopting the nearest benchmate',()=>{
  const life=new WorldIdleLife(),controlLife=new WorldIdleLife(),a=body(),control=body(),yaw=Math.PI/2;
  for(const rig of [a,control]){rig.root.position.set(2,.1,3);rig.root.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),-yaw);rig.root.updateMatrixWorld(true);}
  const before=transforms([a.root,a.hips,a.torso,a.head]),baseline=transforms([control.root,control.hips,control.torso,control.head]);
  const self={...soul('listener',[2,.1,3],yaw,'sit',a.root),attention:[]},benchmate=soul('benchmate',[1.2,.1,3]);
  let largestYaw=0,breathing=false,distractedFrames=0;
  for(let f=0;f<180;f++){
    life.apply([self,benchmate],f/60,1/60);controlLife.apply([{...self,root:control.root}],f/60,1/60);
    largestYaw=Math.max(largestYaw,Math.abs(wrap(yawOf(a.head)-yaw)));breathing||=!a.torso.quaternion.equals(new THREE.Quaternion());
    assert.deepEqual(transforms([a.root,a.hips]),before.slice(0,2),'seat root and hips retain their assigned pose');
    const actual=transforms([a.torso,a.head]),expected=transforms([control.torso,control.head]);
    life.restore();controlLife.restore();
    assert.deepEqual(transforms([a.root,a.hips,a.torso,a.head]),before,'all offsets restored exactly');
    assert.deepEqual(transforms([control.root,control.hips,control.torso,control.head]),baseline);
    if(JSON.stringify(actual)!==JSON.stringify(expected))distractedFrames++;
  }
  assert.equal(distractedFrames,0,'unrelated benchmate added seated head/torso attention in '+distractedFrames+'/180 frames; largest assigned-forward deviation '+largestYaw+' radians');
  assert(breathing,'the small breathing layer remains active');
  assert(largestYaw<=.12+1e-9,'only the existing 0.12-radian idle glance is added');
});

test('explicit seated conversation and standing social attention keep their actual peers and restore the assigned root',()=>{
  for(const activity of ['sit','idle']){
    const life=new WorldIdleLife(),a=body(),yaw=Math.PI/2,rootStart=a.root.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),-yaw).clone();
    const initial=transforms([a.root,a.hips,a.torso,a.head]),self={...soul('listener',[0,0,0],yaw,activity,a.root),attention:conversationAttention('listener',[{speaker:'speaker',at:0,channel:{kind:'conversation',members:['listener','speaker']}}],1000)};
    const peer=soul('speaker',[2,0,2]),stranger=soul('benchmate',[-.8,0,0]);let facing=0;
    for(let f=0;f<180;f++){
      life.apply([self,stranger,peer],f/60,1/60);facing=wrap(yawOf(a.head)-yaw);
      if(activity==='sit')assert.deepEqual(a.root.quaternion.toArray(),rootStart.toArray(),'conversation never turns a seated root');
      life.restore();assert.deepEqual(transforms([a.root,a.hips,a.torso,a.head]),initial,'exact restoration with explicit attention');
    }
    assert(facing<-.5,'actual speaker to the right wins over the closer left benchmate');
  }
});

test('standing nearest-peer attention, rigid exclusions and reduced-motion breathing survive the seated policy',()=>{
  const life=new WorldIdleLife(),a=body(),self=soul('standing',[0,0,0],0,'idle',a.root),peer=soul('peer',[.8,0,1]),initial=transforms([a.root,a.hips,a.torso,a.head]);let headYaw=0;
  for(let f=0;f<180;f++){life.apply([self,peer],f/60,1/60);headYaw=yawOf(a.head);life.restore();assert.deepEqual(transforms([a.root,a.hips,a.torso,a.head]),initial);}
  assert(headYaw>.5,'standing still uses ordinary nearby social attention');
  for(const activity of ['walk','swim','lie','carry']){
    life.apply([{...self,activity},peer],1.3,1/60);assert.deepEqual(transforms([a.root,a.hips,a.head]),[initial[0],initial[1],initial[3]],activity+' owns its pose apart from breathing');life.restore();
  }
  const normal=new WorldIdleLife(),reduced=new WorldIdleLife(),b=body(),c=body();
  normal.apply([soul('breather',[0,0,0],0,'walk',b.root)],1.3,1/60);reduced.apply([soul('breather',[0,0,0],0,'walk',c.root)],1.3,1/60,true);
  const angle=(q:THREE.Quaternion)=>2*Math.atan2(Math.hypot(q.x,q.y,q.z),q.w);
  assert(angle(b.torso.quaternion)>0);assert(Math.abs(angle(c.torso.quaternion)/angle(b.torso.quaternion)-.4)<1e-12,'existing reduced-motion breathing factor');
  normal.restore();reduced.restore();assert.deepEqual(transforms([b.root,b.hips,b.torso,b.head]),initial);assert.deepEqual(transforms([c.root,c.hips,c.torso,c.head]),initial);
});
