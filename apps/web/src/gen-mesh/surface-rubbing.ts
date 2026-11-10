import * as THREE from 'three';
import {rubbingMarks} from '../../../../packages/world-compiler/src/core-kit/surface-rubbing.ts';
import type {MeshCtx} from './registry.ts';
const owns=(ctx:MeshCtx)=>ctx.def.name==='core-rubbing-paper'&&ctx.def.version===1;
export const rubbingKey=(ctx:MeshCtx)=>owns(ctx)?':'+JSON.stringify(rubbingMarks(ctx.entity.state)):'';
/** Integral deposited charcoal only; actual paper owns all custody/support/bounds. */
export function addRubbing(root:THREE.Object3D,ctx:MeshCtx){
 if(!owns(ctx))return;const marks=rubbingMarks(ctx.entity.state),positions:number[]=[],normals:number[]=[];
 for(const m of marks){const parts:THREE.BufferGeometry[]=m.motif==='grain'?[-.035,0,.035].map(x=>{const g=new THREE.BoxGeometry(.007,.002,.085);g.translate(x,0,0);return g;}):[.023,.045].map(r=>{const g=new THREE.RingGeometry(r-.004,r,12);g.rotateX(-Math.PI/2);return g;});for(const part of parts){const g=part.index?part.toNonIndexed():part;g.translate(m.x,.027+m.slot*.0001,m.z);positions.push(...g.attributes.position.array);normals.push(...g.attributes.normal.array);if(g!==part)g.dispose();part.dispose();}}
 if(!positions.length)return;const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));const mesh=new THREE.Mesh(g,ctx.materials.get('paint','#303432'));mesh.name='committed-rubbings';root.add(mesh);
}
