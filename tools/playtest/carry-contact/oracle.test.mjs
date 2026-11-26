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
 load:{native:'n-load',entity:'e-load',entrySha256:'hash',kind:'test:load',parts:2},grips:[{name:'a',world:[0,1,0]},{name:'b',world:[0,1,1]}],
 bodies:[{native:'n-body',entity:'e-body',soul:'s-body',visibleSkin:true,palms:{left:[0,1,0],right:[0,1,1]}}]});
test('unassigned nearest grip is only a lower bound: both far proves miss; one near never certifies',()=>{
 const s=sample();assert.equal(gradeContact(s,{now:110}).status,'unproved');
 s.bodies[0].palms.right=[1,1,1];assert.equal(gradeContact(s,{now:110}).status,'unproved');
 s.bodies[0].palms.left=[1,1,0];const r=gradeContact(s,{now:110});assert.equal(r.status,'failed-lower-bound');assert.equal(r.contacts[0].nearest.errorM,1);assert.equal(r.ok,false);
});
test('assigned contact requires both hands, and either single-hand miss fails the unchanged 3cm bar',()=>{
 const s=sample();s.assignmentSource='native-authoritative';s.assignmentAt=10;s.assignments=[{body:'n-body',hand:'left',grip:'a'},{body:'n-body',hand:'right',grip:'b'}];
 assert.equal(gradeContact(s,{now:110}).ok,true);
 s.bodies[0].palms.right=[.031,1,1];assert.equal(gradeContact(s,{now:110}).status,'failed-assigned');
 s.bodies[0].palms.right=[0,1,1];s.assignments.pop();assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
});
test('missing/stale/wrong-unit/offscreen-pass observations never pass',()=>{
 for(const mutate of [s=>s.units='mm',s=>s.stage='cached-contactDiagnostics',s=>s.renderTarget={},s=>s.currentCanvas=false,s=>s.bodies[0].palms.left=null,s=>s.bodies[0].visibleSkin=false,s=>s.load.parts=0]){
  const s=sample();mutate(s);assert.equal(gradeContact(s,{now:110}).status,'failed-measurement');
 }
 assert.equal(gradeContact(sample(),{now:400}).status,'failed-measurement');assert.equal(gradeContact(sample(),{now:110,previousFrame:3}).status,'failed-measurement');
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
 for(let i=0;i<105;i++) { const s=sample();s.frame=i+1;if(i===103){s.bodies[0].palms.left=[2,1,0];s.bodies[0].palms.right=[2,1,1];}const r=gradeContact(s,{now:110,previousFrame:i});retainResult(o,s,r,3); }
 assert.equal(o.total,105);assert.equal(o.samples.length,3);assert.equal(o.dropped,102);assert.equal(o.counts['failed-lower-bound'],1);assert.equal(o.failedWitnesses[0].sample.frame,104);assert.equal(o.maxima['n-body:left'].distanceM,2);assert.deepEqual(o.samples.map(x=>x.sample.frame),[1,104,105]);assert.equal(o.interval.first.frame,1);assert.equal(o.interval.last.frame,105);assert.equal(o.interval.last.at,100);assert.equal(o.interval.last.worldSeconds,10);
});
test('a degenerate carrier root and wholly transparent indexed skin cannot certify visibility',()=>{
 const scene=new Scene(),root=new Group(),skin=new Mesh(new BoxGeometry(),new MeshBasicMaterial());skin.isSkinnedMesh=true;skin.userData.bodyDraw=true;root.add(skin);scene.add(root);scene.updateMatrixWorld(true);
 assert.equal(bodyGeometry(root,scene),1);skin.material.opacity=0;assert.throws(()=>bodyGeometry(root,scene),/visible indexed/);skin.material.opacity=1;root.scale.x=0;scene.updateMatrixWorld(true);assert.throws(()=>bodyGeometry(root,scene),/nondegenerate/);
});
