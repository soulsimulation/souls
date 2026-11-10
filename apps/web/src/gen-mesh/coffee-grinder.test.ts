import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {coreLibrary,WorldModel,type Entity} from '@souls/world-compiler';
import {MaterialLib} from './materials.ts';
import {meshFor,type MeshCtx} from './registry.ts';
import './kit.mesh.ts';
test('registered grinder shows conserved integral beans and retained grounds within four draws and400 triangles',()=>{
 const model=new WorldModel({constants:{extent:80,ground:'land'},seed:'coffee-view'});model.library=coreLibrary();const def=model.library.get('core-hand-coffee-grinder@1')!,materials=new MaterialLib(),keys=new Set();
 for(let beans=0;beans<=6;beans++)for(let grounds=0;grounds<=3&&beans+grounds<=6;grounds++){
 const entity={id:'coffee-view',def:def.ref,in:{parent:'world'},by:'test',born:0,v:1,state:{beans,grounds},params:{}}as Entity,ctx:MeshCtx={def,entity,params:{},args:def.make.kind==='gen'?def.make.args as Record<string,unknown>:{},baked:model.bake(def,{},0),model,materials,tint:(k,f)=>k?def.palette?.[k]??f:f};const root=meshFor(def)!.build(ctx)!;let triangles=0,draws=0;root.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;draws+=Math.max(1,m.geometry.groups.length);triangles+=(m.geometry.index?.count??m.geometry.attributes.position.count)/3;});assert.ok(draws<=4,JSON.stringify({beans,grounds,draws}));assert.equal(triangles,108+12*(beans+grounds));assert.ok(triangles<=400);keys.add(meshFor(def)!.instanceKey?.(ctx));
 }assert.equal(keys.size,22);
});
