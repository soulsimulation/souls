import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {WorldModel,coreLibrary,coreRef,applyBatch} from '@souls/world-compiler';
import {buildKit} from './gen-mesh/kit.mesh.ts';
import {MaterialLib} from './gen-mesh/materials.ts';
import {WorldEntityIncense,type IncenseLiveSelection} from './WorldEntityIncense.ts';
import {WorldEntityLayer} from './WorldEntityLayer.ts';
import {prepareIncenseContact,placeIncenseContact} from './incense-contact-context.ts';
import type {IncenseContactRequest} from '../../../mars/viewer/app/engine-view/incense-contact-observation.ts';
import {armUnderlay,indexTipSkin,incenseArmSkin,poseIncenseTipTouch,clearUnownedIncenseArm} from '../../../mars/viewer/app/engine-view/incense-tip-touch.ts';

function fixture(parent?:THREE.Object3D,initialManualMismatch=false){
  const model=new WorldModel({constants:{ground:'land',extent:100},seed:'incense-binding'});model.library=coreLibrary();
  assert.equal(applyBatch(model,{ops:[{op:'place',def:coreRef('incense-censer',1),name:'censer',p:[1.5,3],r:.6}]},'god',1).result.accepted,true);
  const e=model.get('censer')!,def=model.resolvedDef(e.def)!,pose=model.worldPose(e),prepared=prepareIncenseContact(def,e,model.bake(def,e.params??{},e.seed??0,e.shape).box,pose.s)!;
  const context={...placeIncenseContact(prepared,e.id,pose)!,depiction:{armUnderlay,indexTipSkin,incenseArmSkin,poseIncenseTipTouch,clearUnownedIncenseArm}};
  const build=(state=e.state??{})=>{assert.equal(def.make.kind,'gen');const obj=buildKit(def.make.kind==='gen'?def.make.args:{},{materials:new MaterialLib(),params:e.params??{},state,smokeFx:true,tint:(key,fallback)=>key?def.palette?.[key]??fallback:fallback});
    obj.position.set(pose.x,pose.y,pose.z);obj.rotation.y=pose.yaw;obj.scale.setScalar(pose.s);parent?.add(obj);
    if(initialManualMismatch){const mesh=obj.children.find(o=>(o as THREE.Mesh).isMesh)!;mesh.matrixAutoUpdate=false;mesh.matrix.makeTranslation(.125,0,0);}
    obj.updateMatrixWorld(true);return {obj,settled:true};};
  const drawn=new Map([[e.id,build()]]),registry=new WorldEntityIncense();registry.observe(model,e,def,drawn.get(e.id));
  let selection:IncenseLiveSelection={world:'fixture',epoch:'one',nativeNowTick:100,live:true,exact:true,takeId:'take',observedTick:120,messages:[]};
  const read=()=>selection,resolve=()=>registry.resolver(read,(q,s)=>registry.contact(q,s,model,drawn,0));
  const r3=(v:number)=>Math.round(v*1000)/1000;
  const request:IncenseContactRequest={actor:'actor',motion:{target:e.id,at:[...context.tip],startTick:110,actionId:'light'},take:{id:'take',startTick:90,endTick:200,dt:.05},observedTick:120,targetTracked:false,
    nativeTarget:{def:prepared.nativeDef,kind:'fixture',tags:['entity-world'],pose:{p:[pose.x,pose.y,pose.z].map(r3),yaw:r3(-pose.yaw)}}};
  return {model,e,def,pose,context,drawn,registry,resolve,request,select:(q:Partial<IncenseLiveSelection>)=>{selection={...selection,...q};},build};
}
test('real kit binding preserves geometry-neutral on/off and refuses pending edits or stale rendered attributes',()=>{
  const f=fixture(),resolve=f.resolve();f.select({nativeNowTick:150});
  assert.deepEqual(resolve(f.request),f.context);
  const on={...f.e,state:{on:true}},diff={kind:'world-diff',seq:1,diff:{upserts:[on],removes:[],defs:[]}};
  f.select({messages:[diff]});assert.deepEqual(resolve(f.request),f.context,'queued native on state is geometry-neutral');
  f.registry.invalidate(diff);f.drawn.set(f.e.id,f.build({on:true}));f.registry.observe(f.model,on,f.def,f.drawn.get(f.e.id));
  assert.deepEqual(resolve(f.request),f.context,'same authored solid redraw retains pre-episode binding');
  const moved={...on,p:[2,0,3] as [number,number,number]};
  const moving={...diff,diff:{...diff.diff,upserts:[moved]}};
  f.select({messages:[moving]});assert.equal(resolve(f.request),null);
  f.select({messages:[]});const d=f.drawn.get(f.e.id)!;d.obj.visible=false;assert.equal(resolve(f.request),null);d.obj.visible=true;
  const mesh=d.obj.children.find(o=>(o as THREE.Mesh).isMesh) as THREE.Mesh;
  assert.ok(mesh);mesh.geometry=mesh.geometry.clone();mesh.geometry.deleteAttribute('position');
  assert.equal(resolve(f.request),null,'a post-cache replacement is unsupported without throwing');
});
test('binding certifies no past gesture and disables historical, nearest, mismatched and prior resolver owners',()=>{
  const f=fixture(),first=f.resolve();f.select({nativeNowTick:150});
  assert.equal(first({...f.request,motion:{...f.request.motion,startTick:90}}),null,'first observation cannot certify earlier native motion');
  assert.equal(first({...f.request,targetTracked:true}),null);
  assert.equal(first({...f.request,nativeTarget:{...f.request.nativeTarget!,def:'other'}}),null);
  assert.equal(first({...f.request,motion:{...f.request.motion,at:[0,0,0]}}),null);
  f.select({live:false});assert.equal(first(f.request),null);f.select({live:true,exact:false});assert.equal(first(f.request),null);f.select({exact:true});
  const second=f.resolve();assert.equal(first(f.request),null,'new people resolver retires the previous owner');
  assert.equal(second(f.request),null,'new observer cannot claim an already started episode');
  const future={...f.request,motion:{...f.request.motion,startTick:160},observedTick:170};f.select({nativeNowTick:200,observedTick:170});
  assert.ok(second(future));
  f.registry.reset();assert.equal(second(future),null,'reset requires a genuinely later observed episode');
  f.select({nativeNowTick:220,observedTick:210});assert.ok(second({...future,motion:{...future.motion,startTick:205},observedTick:210}));
});
test('real kit rejects changed cached child transforms and topology, permanently for that root',()=>{
  const changes:Record<string,(root:THREE.Object3D,mesh:THREE.Mesh)=>()=>void>={
    'original shifted solid':(root,mesh)=>{mesh.position.x+=.125;root.updateMatrixWorld(true);return()=>{mesh.position.x-=.125;root.updateMatrixWorld(true);};},
    'shift before matrix update':(_root,mesh)=>{mesh.position.x+=.125;return()=>{mesh.position.x-=.125;};},
    rotation:(_root,mesh)=>{mesh.rotation.z=.2;return()=>{mesh.rotation.z=0;};},
    scale:(_root,mesh)=>{mesh.scale.y=1.1;return()=>{mesh.scale.y=1;};},
    removal:(root,mesh)=>{root.remove(mesh);return()=>{root.add(mesh);};},
    addition:(root)=>{const extra=new THREE.Object3D();root.add(extra);return()=>{root.remove(extra);};},
    reparent:(root,mesh)=>{const extra=new THREE.Group();root.add(extra);extra.add(mesh);return()=>{root.add(mesh);root.remove(extra);};},
    reorder:(root)=>{root.children.reverse();return()=>{root.children.reverse();};},
    nonfinite:(_root,mesh)=>{mesh.position.y=NaN;return()=>{mesh.position.y=0;};},
    'inconsistent manual matrix':(_root,mesh)=>{mesh.matrixAutoUpdate=false;mesh.matrix.makeTranslation(.125,0,0);return()=>{mesh.matrixAutoUpdate=true;mesh.updateMatrix();};},
    'disabled world updates':(_root,mesh)=>{mesh.matrixWorldAutoUpdate=false;return()=>{mesh.matrixWorldAutoUpdate=true;};},
  };
  for(const [name,change]of Object.entries(changes)){
    const f=fixture(),resolve=f.resolve();f.select({nativeNowTick:150});
    if(name==='reorder'){f.drawn.set(f.e.id,f.build({on:true}));f.registry.observe(f.model,f.e,f.def,f.drawn.get(f.e.id));}
    assert.deepEqual(resolve(f.request),f.context,name+' healthy');
    const root=f.drawn.get(f.e.id)!.obj,mesh=root.children.find(o=>o.name==='kit:solid') as THREE.Mesh;assert.ok(mesh);
    const restore=change(root,mesh);assert.equal(resolve(f.request),null,name);restore();
    f.registry.observe(f.model,f.e,f.def,f.drawn.get(f.e.id));assert.equal(resolve(f.request),null,name+' stays unsupported after restoration and re-observation');
    f.drawn.set(f.e.id,f.build());f.registry.observe(f.model,f.e,f.def,f.drawn.get(f.e.id));
    assert.deepEqual(resolve(f.request),f.context,name+' genuine root replacement');
  }
});
test('world binding checks current ancestor locals rather than stale matrixWorld',()=>{
  for(const change of ['translation','manual matrix','reparent','world mode']as const){
    const parent=new THREE.Group(),f=fixture(parent),resolve=f.resolve();f.select({nativeNowTick:150});assert.deepEqual(resolve(f.request),f.context);
    if(change==='translation')parent.position.x=.125;
    if(change==='manual matrix'){parent.matrixAutoUpdate=false;parent.matrix.makeTranslation(.125,0,0);}
    if(change==='reparent')new THREE.Group().add(parent);
    if(change==='world mode')parent.matrixWorldAutoUpdate=false;
    assert.equal(resolve(f.request),null,change+' without a scene matrix update');
    parent.position.x=0;parent.matrixAutoUpdate=true;parent.matrixWorldAutoUpdate=true;parent.removeFromParent();
    assert.equal(resolve(f.request),null,change+' remains unsupported');
  }
  const invalid=fixture(undefined,true),resolve=invalid.resolve();invalid.select({nativeNowTick:150});
  assert.equal(resolve(invalid.request),null,'an initially manual noncanonical matrix is never certified');
});
test('warm witness checks use cached nodes and reject unsupported initial bounds',()=>{
  const f=fixture(),resolve=f.resolve();f.select({nativeNowTick:150});assert.deepEqual(resolve(f.request),f.context);
  f.drawn.get(f.e.id)!.obj.traverse=()=>{throw Error('warm subtree traversal');};
  assert.deepEqual(resolve(f.request),f.context,'warm contact never traverses the subtree');
  const huge=fixture(),root=huge.build();for(let i=0;i<128;i++)root.obj.add(new THREE.Object3D());
  huge.drawn.set(huge.e.id,root);huge.registry.observe(huge.model,huge.e,huge.def,root);
  const bounded=huge.resolve();huge.select({nativeNowTick:150});assert.equal(bounded(huge.request),null);
});
test('real layer freeze and thaw retain exact canonical geometry across on/off root replacements',()=>{
  const f=fixture(),resolve=f.resolve(),layer=new WorldEntityLayer(p=>p);f.select({nativeNowTick:150});
  const lifecycle=layer as unknown as{freeze:(d:{obj:THREE.Object3D})=>void;thaw:(d:{obj:THREE.Object3D})=>void};
  try{
    for(const on of [false,true,false]){
      const entity={...f.e,state:{on}},drawn=f.build(entity.state);f.drawn.set(f.e.id,drawn);f.registry.observe(f.model,entity,f.def,drawn);
      assert.deepEqual(resolve(f.request),f.context,'new authored root');
      lifecycle.freeze(drawn);assert.equal(drawn.obj.matrixAutoUpdate,false);assert.deepEqual(resolve(f.request),f.context,'actual freeze is geometry-equivalent');
      lifecycle.thaw(drawn);assert.equal(drawn.obj.matrixAutoUpdate,true);assert.deepEqual(resolve(f.request),f.context,'actual thaw is geometry-equivalent');
    }
  }finally{layer.dispose();}
});
