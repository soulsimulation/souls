import * as THREE from 'three';
import {chalkLines} from '../../../../packages/world-compiler/src/core-kit/pavement-chalk.ts';
import type {MeshCtx} from './registry.ts';
export const isPavementChalk=(ctx:MeshCtx)=>ctx.def.name==='core-pavement-lines'&&ctx.def.version===1;
export const pavementChalkKey=(ctx:MeshCtx)=>isPavementChalk(ctx)?String(ctx.entity.state?.lines??'[]'):'';
/** Decoration only: the real kit slab owns bounds/support; committed strokes lie above its top. */
export function addPavementChalk(root:THREE.Object3D,ctx:MeshCtx){
 if(!isPavementChalk(ctx))return;const lines=chalkLines(ctx.entity.state?.lines);if(!lines?.length)return;
 const positions:number[]=[],normals:number[]=[],colours:number[]=[];
 for(const s of lines){const g=new THREE.BoxGeometry(Math.hypot(s.x2-s.x1,s.z2-s.z1),.003,.018).toNonIndexed();g.rotateY(-Math.atan2(s.z2-s.z1,s.x2-s.x1));g.translate((s.x1+s.x2)/2,.0265,(s.z1+s.z2)/2);const c=new THREE.Color({red:'#ed5862',blue:'#5da5f5',yellow:'#f5d95d'}[s.colour]);positions.push(...g.attributes.position.array);normals.push(...g.attributes.normal.array);for(let i=0;i<g.attributes.position.count;i++)colours.push(c.r,c.g,c.b);g.dispose();}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colours,3));const mesh=new THREE.Mesh(geometry,ctx.materials.get('paint',undefined,{vertexColors:true}));mesh.name='committed-pavement-chalk';root.add(mesh);
}
