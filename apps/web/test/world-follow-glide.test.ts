import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldFollow } from '../src/WorldFollow.ts';

// VF4: a Soul walks along a street lined with houses that pass between it and the camera.
function street(){
  const g=new THREE.Group(),m=new THREE.MeshBasicMaterial();
  for(let x=-20;x<=40;x+=7){const house=new THREE.Mesh(new THREE.BoxGeometry(5,4,4),m);house.position.set(x,2,4.5);g.add(house);}
  g.updateWorldMatrix(true,true);return g;
}
const sightClear=(root:THREE.Object3D,target:THREE.Vector3,offset:THREE.Vector3)=>{const r=new THREE.Raycaster(target.clone().add(new THREE.Vector3(0,.3,0)),offset.clone().normalize(),.05,offset.length());return r.intersectObject(root,true).length===0;};

test('Follow glides around houses: no jumps, rises/orbits to a clear view, keeps the Soul in sight', () => {
  const root=street(),follow=new WorldFollow();let offset=new THREE.Vector3(0,3,9);const steps:number[]=[];let clear=0;
  for(let i=0;i<600;i++){
    const target=new THREE.Vector3(-15+i/60*1.4,1,0); // 1.4 m/s
    const next=follow.resolve(target,offset,[root],1/60);
    if(i>0)steps.push(next.distanceTo(offset));
    offset=next;if(sightClear(root,target,offset))clear++;
  }
  const worst=Math.max(...steps);
  assert.ok(worst<.35,`largest frame-to-frame camera move ${worst.toFixed(3)} m (no snapping)`);
  assert.ok(clear/600>.85,`Soul in clear sight on ${(clear/6).toFixed(0)}% of frames`);
});

test('Follow keeps one solution while it stays clear (no flipping)', () => {
  const root=street(),follow=new WorldFollow();let offset=new THREE.Vector3(0,3,9);const thetas:number[]=[];
  const target=new THREE.Vector3(3.5,1,0); // standing behind a house
  for(let i=0;i<240;i++){offset=follow.resolve(target,offset,[root],1/60);thetas.push(Math.atan2(offset.x,offset.z));}
  const late=thetas.slice(120);let flips=0;for(let i=2;i<late.length;i++)if(Math.sign(late[i]-late[i-1])!==Math.sign(late[i-1]-late[i-2])&&Math.abs(late[i]-late[i-1])>1e-3)flips++;
  assert.ok(flips<=1,`direction reversals after settling: ${flips}`);
  assert.ok(sightClear(root,target,offset),'settled on a clear view');
});

test('A Soul in a narrow alley: the camera rises over it and never comes into the body', () => {
  const g=new THREE.Group(),m=new THREE.MeshBasicMaterial();
  for(const z of [-1.4,1.4]){const wall=new THREE.Mesh(new THREE.BoxGeometry(40,5,.4),m);wall.position.set(0,2.5,z);g.add(wall);}
  g.updateWorldMatrix(true,true);
  const follow=new WorldFollow(),target=new THREE.Vector3(0,1,0);let offset=new THREE.Vector3(0,2,8);let minR=Infinity;
  for(let i=0;i<300;i++){offset=follow.resolve(target,offset,[g],1/60);if(i>30)minR=Math.min(minR,offset.length());}
  assert.ok(minR>=2.3,`closest camera distance ${minR.toFixed(2)} m`);
  assert.ok(sightClear(g,target,offset),'ends with a clear view (from above the alley)');
});

test('VF6: a drag/zoom in Follow is the view: kept as drawn, not glided back, no drift behind the walk', () => {
  const follow=new WorldFollow(),root=new THREE.Group();let offset=new THREE.Vector3(0,3,9);
  for(let i=0;i<60;i++){const target=new THREE.Vector3(i/60*1.4,1,0);offset=follow.resolve(target,offset,[root],1/60);}
  // The viewer orbits 70° and zooms out by 1.5×, in small per-frame steps (OrbitControls output).
  for(let i=0;i<20;i++){
    const target=new THREE.Vector3((60+i)/60*1.4,1,0),dragged=offset.clone().applyAxisAngle(new THREE.Vector3(0,1,0),70/20*Math.PI/180).multiplyScalar(Math.pow(1.5,1/20));
    follow.userInput(offset,dragged);
    const next=follow.resolve(target,dragged,[root],1/60);
    assert.ok(next.distanceTo(dragged)<1e-6,`frame ${i}: drawn as dragged (${next.distanceTo(dragged).toFixed(4)} m off)`);
    offset=next;
  }
  const held=offset.clone();
  for(let i=0;i<300;i++){const target=new THREE.Vector3((80+i)/60*1.4,1,0);offset=follow.resolve(target,offset,[root],1/60);}
  assert.ok(offset.angleTo(held)<.02,`kept the viewer's angle after release (moved ${(offset.angleTo(held)*180/Math.PI).toFixed(2)}°)`);
  assert.ok(Math.abs(offset.length()-held.length())<.05,'kept the viewer\'s distance');
});

test('#1316: dragging behind a wall decouples the camera: it stays where the viewer put it; Follow again couples it', () => {
  const g=new THREE.Group(),wall=new THREE.Mesh(new THREE.BoxGeometry(20,8,.4),new THREE.MeshBasicMaterial());wall.position.set(0,4,-5);g.add(wall);g.updateWorldMatrix(true,true);
  const follow=new WorldFollow(),target=new THREE.Vector3(0,1,0);let offset=new THREE.Vector3(0,2,8);
  for(let i=0;i<30;i++)offset=follow.resolve(target,offset,[g],1/60);
  assert.equal(follow.held,false,'following: coupled');
  // Orbit 180° in 30 frames: the camera passes behind the wall, as the viewer drags it.
  let minR=Infinity;for(let i=0;i<30;i++){const dragged=offset.clone().applyAxisAngle(new THREE.Vector3(0,1,0),Math.PI/30);follow.userInput(offset,dragged);offset=follow.resolve(target,dragged,[g],1/60);minR=Math.min(minR,offset.length());}
  assert.equal(follow.held,true,'a drag decouples it');
  assert.ok(offset.z<0&&offset.length()>7.5,`the camera is where the viewer put it, behind the wall (r=${offset.length().toFixed(2)})`);
  const held=offset.clone();
  for(let i=0;i<600;i++)offset=follow.resolve(target,offset,[g],1/60);
  assert.ok(offset.distanceTo(held)<1e-6,`ten seconds later nothing has pulled it in (moved ${offset.distanceTo(held).toFixed(3)} m)`);
  assert.ok(minR>=2.39,'never into the body');
  // Follow again: coupled, the wall pulls it in to see the Soul, on an eased glide.
  follow.reset();assert.equal(follow.held,false);
  // (the app's Follow is a flight to the Soul; its first frame here is placed directly, the explicit jump)
  offset=follow.resolve(target,offset,[g],1/60);
  let worst=0;for(let i=0;i<240;i++){const next=follow.resolve(target,offset,[g],1/60);worst=Math.max(worst,next.distanceTo(offset));offset=next;}
  assert.ok(sightClear(g,target,offset),'coupled again, it finds a clear view of the Soul');
  assert.ok(worst<.35,`and moves there without a jump (largest step ${worst.toFixed(3)} m)`);
});

test('#1316: zooming in keeps Follow coupled; zooming out decouples it', () => {
  const follow=new WorldFollow(),target=new THREE.Vector3(0,1,0);let offset=follow.resolve(target,new THREE.Vector3(0,3,9),[],1/60);
  const closer=offset.clone().multiplyScalar(.8);follow.userInput(offset,closer);offset=follow.resolve(target,closer,[],1/60);
  assert.equal(follow.held,false,'a zoom in is still following');
  for(let i=0;i<60;i++)offset=follow.resolve(target,offset,[],1/60);
  const farther=offset.clone().multiplyScalar(1.25);follow.userInput(offset,farther);follow.resolve(target,farther,[],1/60);
  assert.equal(follow.held,true,'a zoom out is the viewer pulling out');
});

test('#1316: a pull out counts over the whole gesture: a slow trackpad zoom out or a slow drag decouples, click jitter does not', () => {
  const at=new THREE.Vector3(0,1,0),up=new THREE.Vector3(0,1,0);
  const run=(step:(o:THREE.Vector3)=>THREE.Vector3,events:number)=>{const f=new WorldFollow();let o=f.resolve(at,new THREE.Vector3(0,3,9),[],1/60);
    for(let i=0;i<events;i++){const next=step(o);f.userInput(o,next);o=f.resolve(at,next,[],1/60);}return f.held;};
  assert.equal(run(o=>o.clone().multiplyScalar(1.004),40),true,'forty 0.4% zoom steps (a slow trackpad scroll) decouple');
  assert.equal(run(o=>o.clone().applyAxisAngle(up,.006),30),true,'a slow drag, 1 px a step, decouples');
  assert.equal(run(o=>o.clone().applyAxisAngle(up,.008),2),false,'2 px of jitter in a click stays coupled');
  assert.equal(run(o=>o.clone().multiplyScalar(1.015),1),false,'a 1.5% slip inside a pinch stays coupled');
});

test('#1316: a zoom in stays a collision camera: with a wall between, the zoomed camera is drawn in front of it', () => {
  const g=new THREE.Group(),wall=new THREE.Mesh(new THREE.BoxGeometry(20,8,.4),new THREE.MeshBasicMaterial());wall.position.set(0,4,4);g.add(wall);g.updateWorldMatrix(true,true);
  const follow=new WorldFollow(),target=new THREE.Vector3(0,1,0);
  let offset=follow.resolve(target,new THREE.Vector3(0,1.5,8),[g],1/60);   // the first frame is placed as asked: behind the wall
  const closer=offset.clone().multiplyScalar(.95);follow.userInput(offset,closer);offset=follow.resolve(target,closer,[g],1/60);
  assert.equal(follow.held,false,'zooming in is still following');
  assert.ok(target.clone().add(offset).z<3.8,`in front of the wall (z=${target.clone().add(offset).z.toFixed(2)})`);
});

test('#1316: out of a balloon basket, the zoomed-out view is kept for the whole ride, never pulled back in', () => {
  // A basket (four 1.1 m walls round the Soul) under an envelope, carried along as it flies.
  const ride=new THREE.Group(),m=new THREE.MeshBasicMaterial();
  for(const [x,z,w,d] of [[0,.8,1.6,.08],[0,-.8,1.6,.08],[.8,0,.08,1.6],[-.8,0,.08,1.6]] as const){const wall=new THREE.Mesh(new THREE.BoxGeometry(w,1.1,d),m);wall.position.set(x,.55,z);ride.add(wall);}
  const envelope=new THREE.Mesh(new THREE.SphereGeometry(3,16,12),m);envelope.position.y=6;ride.add(envelope);
  const follow=new WorldFollow();let offset=new THREE.Vector3(0,1.5,6);
  const at=(i:number)=>{ride.position.set(i/60*4,20+Math.sin(i/90),0);ride.updateWorldMatrix(true,true);return new THREE.Vector3(ride.position.x,ride.position.y+1,ride.position.z);};
  for(let i=0;i<180;i++)offset=follow.resolve(at(i),offset,[ride],1/60);
  const coupled=offset.length();
  // The viewer zooms out in wheel notches (each 12% farther than the camera as drawn), one every 150 ms.
  let worst=0;
  for(let n=0;n<8;n++){const out=offset.clone().multiplyScalar(1.12);follow.userInput(offset,out);
    for(let k=0;k<9;k++){const next=follow.resolve(at(180+n*9+k),k?offset:out,[ride],1/60);if(k)worst=Math.max(worst,next.distanceTo(offset));else assert.ok(next.distanceTo(out)<1e-6,`notch ${n}: drawn where the wheel put it`);offset=next;}}
  assert.equal(follow.held,true);
  assert.ok(worst<1e-6,`between notches nothing moves it (largest step ${worst.toFixed(3)} m)`);
  const kept=offset.clone();assert.ok(kept.length()>coupled*2,`out of the basket, ${kept.length().toFixed(2)} m from ${coupled.toFixed(2)} m`);
  for(let i=252;i<252+60*60;i++){offset=follow.resolve(at(i),offset,[ride],1/60);assert.ok(offset.distanceTo(kept)<1e-6,`frame ${i}: the view stays where the viewer put it`);}
});

test('Follow ignores speech-bubble sprites: no raycast errors and they never pull the camera in', () => {
  const root=street(),bubble=new THREE.Sprite(new THREE.SpriteMaterial());bubble.position.set(0,2,3);root.add(bubble);root.updateWorldMatrix(true,true);
  const errors:unknown[][]=[],orig=console.error;console.error=(...a:unknown[])=>{errors.push(a);};
  try{const follow=new WorldFollow();let offset=new THREE.Vector3(0,3,9);for(let i=0;i<30;i++)offset=follow.resolve(new THREE.Vector3(0,1,0),offset,[root],1/60);}finally{console.error=orig;}
  assert.deepEqual(errors,[]);
});
