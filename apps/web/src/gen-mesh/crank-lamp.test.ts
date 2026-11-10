import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {coreLibrary,WorldModel,type Entity} from '@souls/world-compiler';
import {MaterialLib} from './materials.ts';
import {meshFor,type MeshCtx} from './registry.ts';
import './kit.mesh.ts';
test('registered lamp retains crank, charge markers and selected lens state within the draw budget',()=>{
 const model=new WorldModel({constants:{extent:80,ground:'land'},seed:'crank-lamp-view'});model.library=coreLibrary();const def=model.library.get('core-crank-inspection-lamp@1')!,materials=new MaterialLib();
 const view=(charge:number,on:boolean)=>{const entity={id:'lamp-view',name:'lamp',def:def.ref,in:{parent:'world'},by:'test',born:0,v:1,state:{charge,on},params:{}} as Entity,ctx:MeshCtx={def,entity,params:{},args:def.make.kind==='gen'?def.make.args as Record<string,unknown>:{},baked:model.bake(def,{},0),model,materials,tint:(k,f)=>k?def.palette?.[k]??f:f};const root=meshFor(def)!.build(ctx)!;let triangles=0,draws=0,glow=0;root.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;draws+=Math.max(1,m.geometry.groups.length);triangles+=(m.geometry.index?.count??m.geometry.attributes.position.count)/3;for(const mat of Array.isArray(m.material)?m.material:[m.material])glow+=((mat as THREE.MeshStandardMaterial).emissiveIntensity??0);});assert.ok(draws<=4);assert.ok(triangles<=400);return{triangles,glow,key:meshFor(def)!.instanceKey?.(ctx)};};
 const empty=view(0,false),full=view(6,false),lit=view(5,true);assert.equal(full.triangles-empty.triangles,72);assert.notEqual(full.key,empty.key);assert.notEqual(lit.key,full.key);assert.ok(lit.glow>full.glow);assert.ok(def.components.light);assert.equal(def.components.light.range,4.5);
});
