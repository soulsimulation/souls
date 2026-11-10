import * as THREE from 'three';
import {collagePatches,COLLAGE_COLOURS} from '../../../../packages/world-compiler/src/core-kit/collage.ts';
import type {MeshCtx} from './registry.ts';
export const isCollage=(ctx:MeshCtx)=>ctx.def.name==='core-collage-board'&&ctx.def.version===1;
export const collageKey=(ctx:MeshCtx)=>isCollage(ctx)?JSON.stringify(collagePatches(ctx.entity.state)):'';
/** Decoration only: the fixed real backing owns bounds/support; committed paper material lies above its surface. */
export function addCollage(root:THREE.Object3D,ctx:MeshCtx){
 if(!isCollage(ctx))return;const lines=collagePatches(ctx.entity.state);if(!lines?.length)return;
 const positions:number[]=[],normals:number[]=[],colours:number[]=[];
 for(const s of lines){const [w,d]=s.shape==='tall'?[.18,.3]:[.3,.18],g=new THREE.BoxGeometry(w,.004,d).toNonIndexed();g.rotateY(s.yaw);g.translate(s.x,1.046+s.slot*.00025,s.z);const c=new THREE.Color(COLLAGE_COLOURS[s.colour as keyof typeof COLLAGE_COLOURS]);positions.push(...g.attributes.position.array);normals.push(...g.attributes.normal.array);for(let i=0;i<g.attributes.position.count;i++)colours.push(c.r,c.g,c.b);g.dispose();}
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colours,3));const mesh=new THREE.Mesh(geometry,ctx.materials.get('paint',undefined,{vertexColors:true}));mesh.name='committed-collage';root.add(mesh);
}
