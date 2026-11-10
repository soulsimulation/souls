import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {coreLibrary,WorldModel,type Entity} from '@souls/world-compiler';
import {CANDLE_COLORS} from '../../../../packages/world-compiler/src/core-kit/candle-molding.ts';
import {meshFor,type MeshCtx} from './registry.ts';
import {MaterialLib} from './materials.ts';
import './kit.mesh.ts';
test('registered candle builder shows selected form/color and on-only flame within existing raw budget',()=>{
 const model=new WorldModel({constants:{extent:80,ground:'land'},seed:'candle-render'});model.library=coreLibrary();const materials=new MaterialLib(),def=model.library.get('core-molded-candle@1')!;
 const draw=(form:string,wax:string,on:boolean)=>{
  const params={form,wax},entity:Entity={id:'render-candle',name:'molded candle',def:def.ref,in:{parent:'world'},by:'test',born:0,v:1,state:{on},params};
  const ctx:MeshCtx={def,entity,params,args:def.make.kind==='gen'?def.make.args as Record<string,unknown>:{},baked:model.bake(def,params,0),model,materials,tint:(key,fallback)=>key?params[key as keyof typeof params]??def.palette?.[key]??fallback:fallback};
  const root=meshFor(def)!.build(ctx)!;let triangles=0,vertices=0,waxVertices=0;const color=new THREE.Color(wax);
  root.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;const p=m.geometry.attributes.position,c=m.geometry.attributes.color;vertices+=p.count;triangles+=(m.geometry.index?.count??p.count)/3;if(c)for(let i=0;i<c.count;i++)if(Math.abs(c.getX(i)-color.r)<1e-6&&Math.abs(c.getY(i)-color.g)<1e-6&&Math.abs(c.getZ(i)-color.b)<1e-6)waxVertices++;});
  assert.ok(triangles>0&&triangles<=400);assert.ok(waxVertices>0);return{triangles,vertices};
 };
 for(const wax of Object.values(CANDLE_COLORS))for(const form of ['pillar','taper']){const off=draw(form,wax,false),on=draw(form,wax,true);assert.ok(on.vertices>off.vertices,'flame is visible only when on');assert.deepEqual(draw(form,wax,false),off,'return to unlit material');}
 assert.notDeepEqual(draw('pillar',CANDLE_COLORS.red,false),draw('taper',CANDLE_COLORS.red,false),'chosen forms retain distinct authored geometry');
});
