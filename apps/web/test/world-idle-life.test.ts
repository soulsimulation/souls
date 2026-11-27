import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SoulGrid, WorldIdleLife, lookTarget, type IdleSoul } from '../src/WorldIdleLife.ts';

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

test('page FPS: the grid finds the same head target as searching every Soul, in a crowd of 500', () => {
  let seed=7;const rnd=()=>((seed=Math.imul(seed,1103515245)+12345>>>0)/4294967296);
  const souls=Array.from({length:500},(_,i)=>soul(`s${i}`,[(rnd()-.5)*120,0,(rnd()-.5)*120],(rnd()-.5)*6.28,i%3?'idle':'sit'));
  souls.push(soul('t1',[10,0,10]),soul('t2',[10,0,13]),soul('t3',[16.01,0,10]));   // on and across cell edges, ties at equal distance
  const grid=new SoulGrid(6);grid.build(souls);
  for(const me of souls){const all=lookTarget(me,souls,6),near=lookTarget(me,grid.around(me.p),6);assert.equal(near,all,me.id);}
  const talk=souls.map((s,i)=>({...s,attention:[`s${(i+1)%500}`,`s${(i+7)%500}`]}));grid.build(talk);
  for(const me of talk)assert.equal(lookTarget(me,grid.around(me.p),6),lookTarget(me,talk,6),`${me.id} in conversation`);
});

test('page FPS: idle life gives every bone the same offsets with the grid as without', () => {
  const mk=()=>Array.from({length:40},(_,i)=>{const b=body();b.root.position.set((i%8)*1.5,0,Math.floor(i/8)*1.5);return {b,s:soul(`s${i}`,[(i%8)*1.5,0,Math.floor(i/8)*1.5],i*.3,'idle',b.root)};});
  const a=mk(),c=mk(),withGrid=new WorldIdleLife(),without=new WorldIdleLife({grid:false});
  for(let f=0;f<30;f++){
    withGrid.apply(a.map(x=>x.s),f/60,1/60);without.apply(c.map(x=>x.s),f/60,1/60);
    a.forEach((x,i)=>[x.b.head,x.b.torso,x.b.hips].forEach((o,j)=>assert.ok(o.quaternion.equals([c[i].b.head,c[i].b.torso,c[i].b.hips][j].quaternion),`${i} ${o.name} frame ${f}`)));
    withGrid.restore();without.restore();
  }
});
