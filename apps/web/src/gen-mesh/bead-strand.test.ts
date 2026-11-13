import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {WorldModel,coreLibrary,type Entity} from '@souls/world-compiler';
import {MaterialLib} from './materials.ts';
import {meshFor,type MeshCtx} from './registry.ts';
import './kit.mesh.ts';
test('registered strand keeps six visible beads across stock, ordered placements and recovery within budgets',()=>{
 const model=new WorldModel({constants:{extent:100,ground:'land'},seed:'bead-view'});model.library=coreLibrary();const def=model.library.get('core-bead-strand@1')!;
 function draw(state:Record<string,unknown>){const entity:Entity={id:'strand-view',name:'strand',def:def.ref,in:{parent:'world'},by:'test',born:0,v:1,state,params:{}};const materials=new MaterialLib(),ctx:MeshCtx={def,entity,params:{},args:def.make.kind==='gen'?def.make.args as Record<string,unknown>:{},baked:model.bake(def,{},0),model,materials,tint:(key,fallback)=>key?def.palette?.[key]??fallback:fallback};const root=meshFor(def)!.build(ctx)!;let triangles=0,draws=0,beadVertices=0;const mats=new Set();root.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;triangles+=(m.geometry.index?.count??m.geometry.attributes.position.count)/3;draws+=Math.max(1,m.geometry.groups.length);for(const material of[].concat(m.material as never))mats.add(material);const a=m.geometry.attributes.color;if(a)for(let i=0;i<a.count;i++)for(const c of['red','blue','amber']){const want=new THREE.Color(def.palette![c]);if(Math.abs(a.getX(i)-want.r)<1e-6&&Math.abs(a.getY(i)-want.g)<1e-6&&Math.abs(a.getZ(i)-want.b)<1e-6)beadVertices++;}});assert.ok(triangles<=400);assert.ok(draws<=4);assert.ok(mats.size<=4);return{triangles,beadVertices};}
 const empty={...Object.fromEntries(Array.from({length:6},(_,i)=>['slot'+(i+1),'empty'])),redStock:2,blueStock:2,amberStock:2};const stock=draw(empty),one=draw({...empty,slot1:'red',redStock:1}),full=draw({...empty,slot1:'red',slot2:'blue',slot3:'amber',slot4:'red',slot5:'blue',slot6:'amber',redStock:0,blueStock:0,amberStock:0});assert.ok(stock.beadVertices>0);assert.deepEqual(one,stock);assert.deepEqual(full,stock);assert.deepEqual(draw(empty),stock);
});
