import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanViews} from '../../../mars/viewer/app/engine-view/humans.ts';
import {templateFromGltf} from '../../../mars/viewer/app/engine-view/people.ts';
import {CHARACTER_WIRE} from '../../../mars/viewer/app/engine-view/character-wire.ts';
import {guitarPose,poseGuitarHand} from '../../../mars/viewer/app/engine-view/guitar-contact.ts';
import {makeProp} from '../../../mars/viewer/app/engine-view/activity-poses.ts';
import {emptyWorld,human} from '../../../mars/viewer/engine/world/factory.ts';
import {Runtime} from '../../../mars/viewer/engine/runtime/runtime.ts';
import {Spatial} from '../../../mars/viewer/engine/spatial/service.ts';
import {openGround} from '../../../mars/viewer/engine/test/frame-fixtures.ts';
let tpl;
async function glb(file){
 const source=readFileSync(new URL('../../../mars/viewer/public/modular/environment/'+file,import.meta.url)),len=source.readUInt32LE(12),j=JSON.parse(source.subarray(20,20+len).toString()),bin=source.subarray(20+len);
 j.materials=j.materials?.map(()=>({pbrMetallicRoughness:{baseColorFactor:[.5,.5,.5,1]}}));delete j.textures;delete j.images;delete j.samplers;
 let json=Buffer.from(JSON.stringify(j));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);const h=Buffer.from(source.subarray(0,20));h.writeUInt32LE(20+json.length+bin.length,8);h.writeUInt32LE(json.length,12);const b=Buffer.concat([h,json,bin]);return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');
}
async function views(){
 if(!tpl){const wire=CHARACTER_WIRE.woman,g=await glb(wire.mesh);g.animations=(await glb(wire.clips)).animations;tpl=templateFromGltf('guitar-failure-fixture',g);}
 const v=new HumanViews();v.setTemplates([tpl]);return v;
}
const frame=(id='guitar_failure')=>({id,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:'idle',restAge:0});
const bones=arm=>[arm.upper,arm.lower,arm.hand,...arm.fingers,...arm.thumb];
const snapshot=arm=>bones(arm).map(o=>({position:o.position.toArray(),quaternion:o.quaternion.toArray()}));
function impossibleProp(){const p=makeProp('guitar');for(const child of p.children.slice(0,4))child.scale.multiplyScalar(100);return p;}
for(const failure of ['corridor','missing-skin','unsupported-rig'])test(`guitar ${failure}: named local failure restores captured native arm without claiming contact`,async()=>{
 const v=await views();v.setFrame([frame()],100);v.render(1);const view=v.views.get('guitar_failure'),arm=view.arms.find(a=>a.side<0),before=snapshot(arm),pose=guitarPose('guitar_fixture',100,4),prop=failure==='corridor'?impossibleProp():makeProp('guitar');
 const model=failure==='missing-skin'?new THREE.Group():view.rig.model,original=arm.fingers;if(failure==='unsupported-rig')arm.fingers=[];
 const contact=new THREE.Vector3(pose.right[0],pose.right[2],pose.right[1]);
 const result=poseGuitarHand(arm,view.rig.holder,model,contact,new THREE.Vector3(1,0,0),new THREE.Vector3(0,0,1),1,1,prop,pose);
 arm.fingers=original;assert.deepEqual(snapshot(arm),before,'all captured native positions/quaternions restored');
 assert.equal(result.diagnostic?.code,`guitar.pose.${failure==='corridor'?'corridor-infeasible':failure==='missing-skin'?'geometry-missing':'unsupported-rig'}`);
 assert.equal(result.diagnostic.side,'right');
 if(failure==='corridor'){assert.ok(result.target?.toArray().every(Number.isFinite),'retain actual unsatisfied requested goal');assert.ok(arm.hand.getWorldPosition(new THREE.Vector3()).distanceTo(result.target)>.015,'request is not rewritten to attained underlay');}
 else assert.equal(result.target,null,'no fabricated goal before geometry/request can be formed');
});
test('infeasible guitar is actor-local: native clock and healthy actor continue; bilateral diagnostics reset next healthy frame',async()=>{
 const v=await views(),scene=openGround(),world=emptyWorld('guitar-failure-fixture',scene);
 for(const [id,x]of [['guitar_failure',0],['guitar_healthy',3]]){const e=human(id,x,0);e.human.activity='play-music';e.human.instrument='guitar';world.entities[id]=e;}
 const rt=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]);v.onTick(world);
 const failed=v.views.get('guitar_failure'),bad=impossibleProp();bad.name='activity prop: guitar';failed.prop={kind:'guitar',obj:bad};failed.rig.holder.add(bad);
 let previous;
 for(let k=0;k<24;k++){
  rt.step();assert.doesNotThrow(()=>{v.onTick(world);v.render(1);});
  if(k<18)continue;
  const a=v.bones('guitar_failure').guitar_failure,b=v.bones('guitar_healthy').guitar_healthy;
  assert.ok(a.guitar?.some(d=>d.code==='guitar.pose.corridor-infeasible'),'bad actor reports named local infeasible corridor');
  assert.equal(b.guitar,undefined,'other actor has no failure');assert.ok(b.arms.every(a=>a.target&&a.err!==null&&a.err<.015),'other actor genuinely attains request');
  assert.ok(a.arms.some(a=>a.target&&a.err>.015&&a.contact===0),'failed actor retains unmet target, never fake contact');
  assert.ok(bad.visible,'native guitar remains visible');bad.traverse(o=>{if(o.isMesh)for(const m of [o.material].flat())assert.equal(m.opacity,1);});
  if(previous)assert.notDeepEqual(b.arms.map(a=>a.palm),previous,'healthy actor keeps animating');previous=b.arms.map(a=>a.palm);
 }
 assert.equal(world.tick,24,'native clock advances despite local pose failures');assert.equal(world.entities.guitar_failure.human.activity,'play-music','native faculty never refused');
 // A healthy arm must not clear another arm's diagnostic; a later healthy frame clears all stale failures.
 assert.ok(v.bones('guitar_failure').guitar_failure.guitar.length>=1);
 failed.rig.holder.remove(bad);failed.prop=undefined;rt.step();v.onTick(world);v.render(1);
 assert.equal(v.bones('guitar_failure').guitar_failure.guitar,undefined,'next valid frame clears stale diagnostic');
});
test('one unsupported arm retains its diagnostic after the healthy arm solves',async()=>{
 const v=await views();v.setFrame([frame()],100);v.render(1);const view=v.views.get('guitar_failure'),arm=view.arms.find(a=>a.side>0),original=arm.fingers;arm.fingers=[];
 v.setFrame([{...frame(),activity:'play-music',instrument:'guitar',activityAge:4}],101);v.render(1);
 const d=v.bones('guitar_failure').guitar_failure;assert.deepEqual(d.guitar.map(x=>x.side),['left']);assert.equal(d.arms.find(x=>x.side==='left').target,null);assert.ok(d.arms.find(x=>x.side==='right').target);
 arm.fingers=original;v.setFrame([{...frame(),activity:'play-music',instrument:'guitar',activityAge:4}],101.1);v.render(1);assert.equal(v.bones('guitar_failure').guitar_failure.guitar,undefined);
});

test('unmapped arm chains report bilateral actor-local diagnostics without stopping rendering',async()=>{
 const v=await views();v.setFrame([frame()],100);v.render(1);const view=v.views.get('guitar_failure');view.arms=[];
 v.setFrame([{...frame(),activity:'play-music',instrument:'guitar',activityAge:4}],101);assert.doesNotThrow(()=>v.render(1));
 const d=v.bones('guitar_failure').guitar_failure;assert.deepEqual(d.guitar.map(x=>x.side),['left','right']);assert.ok(d.guitar.every(x=>x.code==='guitar.pose.unsupported-rig'));assert.equal(d.arms.length,0);
});
