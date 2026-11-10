import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {coreLibrary,WorldModel,type Entity} from '@souls/world-compiler';
import {meshFor,type MeshCtx} from './registry.ts';
import {MaterialLib} from './materials.ts';
import './kit.mesh.ts';

test('actual registered stand replaces supplied paper with charred material and removes flame when extinguished',()=>{
 const model=new WorldModel({constants:{extent:100,ground:'land'},seed:'intention'});model.library=coreLibrary();const def=model.library.get('core-intention-burner@1')!,materials=new MaterialLib();
 const draw=(spent:boolean,on:boolean)=>{
  const entity:Entity={id:'ritual-render',name:'ritual',def:def.ref,in:{parent:'world'},by:'test',born:0,v:1,state:{spent,on,text:spent?'Words released.':'My intention'}};
  const ctx:MeshCtx={def,entity,params:{},args:def.make.kind==='gen'?def.make.args as Record<string,unknown>:{},baked:model.bake(def,{},0),model,materials,tint:(key,fallback)=>key?def.palette?.[key]??fallback:fallback};
  const root=meshFor(def)!.build(ctx)!;let paper=0,char=0,flames=0;const p=new THREE.Color('#f1e4c5'),a=new THREE.Color('#302d28');
  root.traverse(o=>{flames+=(o.userData.flames as unknown[]|undefined)?.length??0;const m=o as THREE.Mesh;if(!m.isMesh)return;const c=m.geometry.attributes.color;if(!c)return;for(let i=0;i<c.count;i++){const same=(x:THREE.Color)=>Math.abs(c.getX(i)-x.r)<1e-6&&Math.abs(c.getY(i)-x.g)<1e-6&&Math.abs(c.getZ(i)-x.b)<1e-6;if(same(p))paper++;if(same(a))char++;}});
  return{paper,char,flames};
 };
 const raw=draw(false,false),burning=draw(true,true),out=draw(true,false);assert.ok(raw.paper>0);assert.equal(raw.char,0);assert.equal(raw.flames,0);assert.equal(burning.paper,0);assert.ok(burning.char>0);assert.ok(burning.flames>0);assert.equal(out.paper,0);assert.equal(out.char,burning.char);assert.equal(out.flames,0);assert.deepEqual(draw(false,false),raw,'state-specific builder cache remains correct');
});
