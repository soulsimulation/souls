import * as THREE from 'three';
import {embroideryStitches} from '../../../../packages/world-compiler/src/core-kit/embroidery.ts';
import type {MeshCtx} from './registry.ts';
export const isEmbroidery=(ctx:MeshCtx)=>ctx.def.name==='core-embroidery-hoop'&&ctx.def.version===1;
export const embroideryKey=(ctx:MeshCtx)=>isEmbroidery(ctx)?JSON.stringify(embroideryStitches(ctx.entity.state)):'';
/** Decoration only: the real hoop owns bounds/support; committed stitches lie above its cloth. */
export function addEmbroidery(root:THREE.Object3D,ctx:MeshCtx){
 if(!isEmbroidery(ctx))return;const lines=embroideryStitches(ctx.entity.state);if(!lines?.length)return;
 const positions:number[]=[],normals:number[]=[],colours:number[]=[];
 for(const s of lines){const g=new THREE.BoxGeometry(Math.hypot(s.x2-s.x1,s.z2-s.z1),.003,.009).toNonIndexed();g.rotateY(-Math.atan2(s.z2-s.z1,s.x2-s.x1));g.translate((s.x1+s.x2)/2,.037,(s.z1+s.z2)/2);const c=new THREE.Color({red:'#ed5862',blue:'#5da5f5',gold:'#dfb63c'}[s.colour]);positions.push(...g.attributes.position.array);normals.push(...g.attributes.normal.array);for(let i=0;i<g.attributes.position.count;i++)colours.push(c.r,c.g,c.b);g.dispose();}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colours,3));const mesh=new THREE.Mesh(geometry,ctx.materials.get('paint',undefined,{vertexColors:true}));mesh.name='committed-embroidery';root.add(mesh);
}
