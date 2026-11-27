import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {drawnLoad,drawnGrips,observeRender,gradeContact,retainResult,bodyGeometry} from './oracle.mjs';
const {Scene,Group,Mesh,BoxGeometry,MeshBasicMaterial,InstancedMesh,Matrix4,Vector3,Euler,Quaternion}=createRequire(new URL('../../../mars/viewer/package.json',import.meta.url))('three');
const matrix=(p=[0,0,0],r=[0,0,0],s=1)=>new Matrix4().compose(new Vector3(...p),new Quaternion().setFromEuler(new Euler(...r)),new Vector3(s,s,s));
const entry={format:'souls-entry/1',points:{a:{role:'grip',at_mm:[0,100,500]},b:{role:'grip',at_mm:[0,100,-500]}}};
function instanced(){
 const scene=new Scene(),parent=new Group();parent.position.set(4,1,2);parent.rotation.y=.7;scene.add(parent);
 const root=matrix([1,.8,2],[.3,.5,-.2],1.7),locals=[matrix([0,.1,.5],[.1,0,0]),matrix([0,.1,-.5],[0,.2,0])];
 const meshes=locals.map(local=>{const m=new InstancedMesh(new BoxGeometry(.1,.2,1),new MeshBasicMaterial(),2);m.count=2;m.setMatrixAt(1,root.clone().multiply(local));parent.add(m);return m;});
 scene.updateMatrixWorld(true);
 const pool={slots:new Map([['load',1]]),parts:locals.map(local=>({local})),meshes};
 const placeholder=new Group();placeholder.position.set(999,999,999); // Never rendered and deliberately wrong.
 const layer={drawn:new Map([['load',{inst:'k',obj:placeholder,shown:true}]]),instancer:{pools:new Map([['k',pool]])}};
 return{scene,parent,root:parent.matrixWorld.clone().multiply(root),layer,pool};
}
test('actual instance matrices include mesh parents and cancel each geometry-local offset, ignoring placeholder',()=>{
 const f=instanced(),actual=drawnLoad(f.layer,f.scene,'load');
 actual.matrix.elements.forEach((n,i)=>assert.ok(Math.abs(n-f.root.elements[i])<1e-7));assert.equal(actual.parts,2);
 const grips=drawnGrips(entry,actual.matrix,(...p)=>new Vector3(...p));
 assert.ok(new Vector3(...grips[0].world).distanceTo(new Vector3(0,.1,.5).applyMatrix4(f.root))<1e-7);
 assert.notDeepEqual(grips[0].world,[0,100,500],'millimetres are converted before world transform');
 f.pool.meshes[1].setMatrixAt(1,matrix([99,0,0]));assert.throws(()=>drawnLoad(f.layer,f.scene,'load'),/parts disagree/);
});
test('unknown slots, singular geometry transforms, hidden parts and detached placeholders fail',()=>{
 for(const mutate of [f=>f.pool.slots.delete('load'),f=>f.pool.parts[0].local.makeScale(0,1,1),f=>f.pool.meshes[0].visible=false,f=>f.layer.drawn.get('load').inst=undefined]){
  const f=instanced();mutate(f);assert.throws(()=>drawnLoad(f.layer,f.scene,'load'));
 }
 const f=instanced();assert.throws(()=>drawnGrips({...entry,points:{a:{role:'grip',at_mm:[0,.1,1]}}},f.root,(...p)=>new Vector3(...p)),/whole millimetres/);
});
const sample=()=>({stage:'after-world-render',units:'m',currentCanvas:true,renderTarget:null,frame:3,at:100,worldSeconds:10,
 load:{native:'n-load',entity:'e-load',entrySha256:'hash',kind:'test:load',parts:2,matrix:new Matrix4().toArray()},grips:[{name:'a',world:[0,1,0]},{name:'b',world:[0,1,1]}],
 bodies:[{native:'n-body',entity:'e-body',soul:'s-body',visibleSkin:true,order:[0,1],palms:{left:[0,1,-.2],right:[0,1,.2]}}]});
function nativeSample(){const s=sample();s.crew={native:'n-crew',source:'native-membership',observedWorldUs:10_000_000,members:['n-body']};s.nativeContacts={source:'souls:carry-grips',units:'um',space:'load-local',observedWorldUs:10_000_000,crew:'n-crew',load:'n-load',phase:'souls:carry',sinceUs:9_000_000,holds:[{body:'n-body',grip:'point:a',gripUm:[0,1_000_000,0],handsUm:[[0,1_000_000,-200_000],[0,1_000_000,200_000]]}]};s.nativeHistory=[s.nativeContacts];s.expectedLoad={source:'native-records',atUs:10000000,previousAtUs:9983333,matrix:new Matrix4().toArray(),previousMatrix:new Matrix4().toArray(),pointsUm:[[-3000000,0,0],[3000000,0,0]]};return s;}
test('unknown native contacts stay unproved: entry-centre distances are not offset-contact bounds',()=>{
 const s=sample();s.bodies[0].palms.left=[200,1,0];s.bodies[0].palms.right=[200,1,1];
 const r=gradeContact(s,{now:110});assert.equal(r.status,'unproved');assert.equal(r.ok,false);assert.equal(r.legacy.certifiesNativeContact,false);assert.equal(r.legacy.contacts[0].nearest.distanceM,200);
 const assigned=nativeSample(),pass=gradeContact(assigned,{now:110});assert.equal(pass.status,'passed-native-pair');assert.equal(pass.legacy.contacts[0].nearest.distanceM,.2,'correct offset contact is 20cm from entry centre');
});
test('native pair is matched bijectively, without guessing anatomical labels or reusing one point',()=>{
 const s=nativeSample();[s.bodies[0].palms.left,s.bodies[0].palms.right]=[s.bodies[0].palms.right,s.bodies[0].palms.left];
 s.bodies[0].order=[1,0];const r=gradeContact(s,{now:110});assert.equal(r.ok,true);assert.deepEqual(r.contacts.map(c=>c.targetIndex),[1,0]);
 assert.equal(gradeContact(s,{now:110,previousAssignments:{'n-crew|n-load|n-body|point:a|9000000':[0,1]}}).status,'failed-measurement');
 s.bodies[0].palms.right=s.bodies[0].palms.left;const duplicate=gradeContact(s,{now:110});assert.equal(duplicate.status,'failed-native-pair');assert.equal(new Set(duplicate.contacts.map(c=>c.targetIndex)).size,2);assert.equal(Math.max(...duplicate.contacts.map(c=>c.errorM)),.4);
 s.nativeContacts.holds[0].handsUm[1]=s.nativeContacts.holds[0].handsUm[0];assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
});
test('either palm beyond 3cm or missing fails, even when the other palm is exact',()=>{
 for(const hand of ['left','right']){
  const s=nativeSample();s.bodies[0].palms[hand][0]=.031;assert.equal(gradeContact(s,{now:110}).status,'failed-native-pair');
  s.bodies[0].palms[hand]=null;assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
 }
});
test('native local micrometre contacts use the actual translated, rotated and scaled load root',()=>{
 const s=nativeSample(),m=matrix([12,2,-3],[.3,1.2,-.2],1.7);s.load.matrix=m.toArray();s.expectedLoad.matrix=m.toArray();s.expectedLoad.previousMatrix=m.toArray();
 for(const[hand,i]of[['left',0],['right',1]])s.bodies[0].palms[hand]=new Vector3(...s.nativeContacts.holds[0].handsUm[i].map(v=>v/1e6)).applyMatrix4(m).toArray();
 assert.equal(gradeContact(s,{now:110}).ok,true);s.load.matrix=new Matrix4().toArray();assert.equal(gradeContact(s,{now:110}).status,'failed-native-pair');
 s.load.matrix=matrix([0,0,0],[0,0,0],0).toArray();assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
});
test('whole crew and exact body/load identities are mandatory, including a missing or duplicate target',()=>{
 const two=()=>{const s=nativeSample();s.crew.members.push('other-body');s.bodies.push({...structuredClone(s.bodies[0]),native:'other-body',entity:'other-entity',soul:'other-soul'});s.nativeContacts.holds.push({...structuredClone(s.nativeContacts.holds[0]),body:'other-body'});return s;};
 assert.equal(gradeContact(two(),{now:110}).ok,true);
 for(const mutate of[s=>s.crew=null,s=>s.crew.members.push('missing-body'),s=>s.bodies.pop(),s=>s.nativeContacts.holds.pop(),s=>s.nativeContacts.holds[1].body='n-body',s=>s.nativeContacts.holds[0].handsUm.pop(),s=>s.nativeContacts.crew='wrong-crew',s=>s.nativeContacts.load='wrong-load',s=>s.crew.observedWorldUs--,s=>s.bodies[1].entity=s.bodies[0].entity]){
  const s=two();mutate(s);assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
 }
});
test('released, expired, future, mismatched-time or wrong-unit native phases cannot certify contact',()=>{
 for(const mutate of[s=>s.nativeContacts.phase='souls:released',s=>s.nativeContacts.observedWorldUs--,s=>s.nativeContacts.sinceUs=10_000_001,s=>s.nativeContacts.units='mm',s=>s.nativeContacts.space='world',s=>s.nativeContacts.holds[0].handsUm[0][0]=.5,s=>{s.nativeContacts.phase='souls:set-in';},s=>{s.nativeContacts.phase='souls:return';s.nativeContacts.untilUs=10_000_000;}]){
  const s=nativeSample();mutate(s);assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
 }
 for(const phase of['souls:set-in','souls:return','souls:held']){const s=nativeSample();s.nativeContacts.phase=phase;if(phase!=='souls:held')s.nativeContacts.untilUs=10_000_001;assert.equal(gradeContact(s,{now:110}).ok,true);}
});
test('missing/stale/wrong-unit/offscreen-pass observations never pass',()=>{
 for(const mutate of [s=>s.units='mm',s=>s.stage='cached-contactDiagnostics',s=>s.renderTarget={},s=>s.currentCanvas=false,s=>s.bodies[0].palms.left=null,s=>s.bodies[0].visibleSkin=false,s=>s.load.parts=0]){
  const s=nativeSample();mutate(s);assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
 }
 assert.equal(gradeContact(nativeSample(),{now:400}).status,'failed-measurement');assert.equal(gradeContact(nativeSample(),{now:110,previousFrame:3}).status,'failed-measurement');
});
test('observer reads post-render live data instead of cached points; preserves this, args, return and invocation',()=>{
 const scene={},camera={},canvas={isConnected:true},token={},errors=[];let calls=0,livePalm=7,cachedPalm=0,observed;
 const renderer={domElement:canvas,info:{render:{frame:0}},getRenderTarget:()=>null,render:function(...args){assert.equal(this,renderer);assert.equal(args[2],token);calls++;livePalm=11;this.info.render.frame++;return token;}};
 const original=renderer.render,world={scene,camera,renderer};const stop=observeRender(renderer,world,stamp=>{observed={palm:livePalm,...stamp};},e=>errors.push(e));
 assert.equal(renderer.render(scene,camera,token),token);assert.equal(calls,1);assert.equal(observed.palm,11);assert.notEqual(observed.palm,cachedPalm);assert.equal(observed.frame,1);
 renderer.render({},camera,token);assert.equal(observed.frame,1,'other scene is not accepted');stop();assert.equal(renderer.render,original);assert.deepEqual(errors,[]);
});

test('every draw is graded after bounded raw storage fills; a later one-frame miss is retained',()=>{
 const o={total:0,counts:{},maxima:{},samples:[],dropped:0,failedWitnesses:[]};
 for(let i=0;i<105;i++) { const s=nativeSample();s.frame=i+1;if(i===103){s.bodies[0].palms.left=[2,1,-.2];s.bodies[0].palms.right=[2,1,.2];}const r=gradeContact(s,{now:110,previousFrame:i});retainResult(o,s,r,3); }
 assert.equal(o.total,105);assert.equal(o.samples.length,3);assert.equal(o.dropped,102);assert.equal(o.counts['failed-native-pair'],1);assert.equal(o.failedWitnesses[0].sample.frame,104);assert.equal(o.maxima['n-body:left'].distanceM,2);assert.deepEqual(o.samples.map(x=>x.sample.frame),[1,104,105]);assert.equal(o.interval.first.frame,1);assert.equal(o.interval.last.frame,105);assert.equal(o.interval.last.at,100);assert.equal(o.interval.last.worldSeconds,10);
});
test('a degenerate carrier root and wholly transparent indexed skin cannot certify visibility',()=>{
 const scene=new Scene(),root=new Group(),skin=new Mesh(new BoxGeometry(),new MeshBasicMaterial());skin.isSkinnedMesh=true;skin.userData.bodyDraw=true;root.add(skin);scene.add(root);scene.updateMatrixWorld(true);
 assert.equal(bodyGeometry(root,scene),1);skin.material.opacity=0;assert.throws(()=>bodyGeometry(root,scene),/visible indexed/);skin.material.opacity=1;root.scale.x=0;scene.updateMatrixWorld(true);assert.throws(()=>bodyGeometry(root,scene),/nondegenerate/);
});
test('hands and load lagging together cannot pass the independent full-pose endpoint clock',()=>{
 const s=nativeSample();s.expectedLoad.matrix=matrix([.1,0,0]).toArray();s.expectedLoad.previousMatrix=matrix([.08,0,0]).toArray();const r=gradeContact(s,{now:110});assert.equal(r.ok,false);assert.equal(r.clock.ok,false);assert(Math.abs(r.clock.clockErrorM-.1)<1e-8);assert(Math.abs(r.clock.oneFrameTravelM-.02)<1e-8);
 const pivot=nativeSample();pivot.expectedLoad.matrix=matrix([0,0,0],[0,.1,0]).toArray();pivot.expectedLoad.previousMatrix=matrix([0,0,0],[0,.095,0]).toArray();const p=gradeContact(pivot,{now:110});assert.equal(p.ok,false);assert(p.clock.clockErrorM>.29,'stationary-root rotation moves the endpoints');
 const missing=nativeSample();delete missing.expectedLoad;assert.equal(gradeContact(missing,{now:110}).status,'failed-measurement');
});

test('an independently recorded release begins a new anatomical episode, while an unaffected membership change cannot reset it',()=>{const s=nativeSample(),old=structuredClone(s.nativeContacts),released={...structuredClone(old),phase:'souls:released',sinceUs:8000000};old.sinceUs=7000000;s.nativeHistory=[old,released,s.nativeContacts];s.bodies[0].order=[1,0];[s.bodies[0].palms.left,s.bodies[0].palms.right]=[s.bodies[0].palms.right,s.bodies[0].palms.left];assert.equal(gradeContact(s,{now:110,previousAssignments:{'n-crew|n-load|n-body|point:a|7000000':[0,1]}}).ok,true);s.nativeHistory=[old,{...s.nativeContacts,sinceUs:8500000},s.nativeContacts];assert.equal(gradeContact(s,{now:110,previousAssignments:{'n-crew|n-load|n-body|point:a|7000000':[0,1]}}).status,'failed-measurement');});
