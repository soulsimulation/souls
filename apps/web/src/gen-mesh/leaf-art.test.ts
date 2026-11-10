import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {coreLibrary, WorldModel, type Entity} from '@souls/world-compiler';
import {meshFor, type MeshCtx} from './registry.ts';
import {MaterialLib} from './materials.ts';
import './kit.mesh.ts';
test('registered leaf geometry conserves material and follows free coordinates with distinct cache entries',()=>{
 const model=new WorldModel({constants:{extent:80,ground:'land'},seed:'leaves'});model.library=coreLibrary();const def=model.library.get('core-leaf-art@1')!,materials=new MaterialLib();
 const draw=(overrides:Record<string,number>)=>{const params={...Object.fromEntries(Object.entries(def.params).map(([key,p])=>[key,p.default])),...overrides};const entity:Entity={id:'leaves',name:'leaves',def:def.ref,in:{parent:'world'},by:'test',born:0,v:1,params};const ctx:MeshCtx={def,entity,params,args:def.make.kind==='gen'?def.make.args as Record<string,unknown>:{},baked:model.bake(def,params,0),model,materials,tint:(k,f)=>k?def.palette?.[k]??f:f};const root=meshFor(def)!.build(ctx)!;root.updateMatrixWorld(true);const points:number[]=[];let triangles=0;root.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;const p=m.geometry.attributes.position;triangles+=(m.geometry.index?.count??p.count)/3;for(let i=0;i<p.count;i++){const v=new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(m.matrixWorld);points.push(v.x,v.y,v.z);}});return{points,triangles};};
 const a=draw({}),b=draw({ax:.13,az:-.07}),again=draw({});assert.ok(a.triangles>0&&a.triangles<=400);assert.equal(a.triangles,b.triangles);assert.equal(a.points.length,b.points.length);assert.notDeepEqual(a.points,b.points);assert.deepEqual(again,a);
});
