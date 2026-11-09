// Guitar geometry and palms share one torso frame. Its origin never follows the moving strumming wrist.
import * as THREE from 'three';
import { GUITAR_FADE, guitarFret, guitarStroke } from './piano-score.ts';
export type GuitarPose={anchor:readonly[number,number,number];weight:number;left:readonly[number,number,number];right:readonly[number,number,number]};
const N=.8660254037844386;
/** Local coordinates are [forward, right, up] from the supported body root. */
export function guitarPoint(p:readonly number[],anchor:readonly number[]):[number,number,number]{
  return [anchor[0]+p[0],anchor[1]-N*p[1]+.5*p[2],anchor[2]+.5*p[1]+N*p[2]];
}
export function guitarPose(seed:string,t:number,age?:number,released?:number,priorAge?:number):GuitarPose{
  const smooth=(x:number)=>{const k=Math.max(0,Math.min(1,x));return k*k*(3-2*k);};
  const w=released===undefined?smooth((age??GUITAR_FADE)/GUITAR_FADE):smooth((priorAge??GUITAR_FADE)/GUITAR_FADE)*(1-smooth(released/GUITAR_FADE));
  const anchor:[number,number,number]=[.25,.10+(1-w)*.20,1.03-(1-w)*.23];
  return {anchor,weight:w,left:guitarPoint([.065,guitarFret(seed,t),0],anchor),right:guitarPoint([.075,.04,guitarStroke(seed,t)*.058],anchor)};
}
/** World matrix of the guitar: face outward, neck diagonally up toward the fretting hand. Scale matches both palm goals. */
export function placeGuitar(obj:THREE.Object3D,origin:THREE.Vector3,fwd:THREE.Vector3,pose:GuitarPose,scale=1){
  const right=new THREE.Vector3(-fwd.z,0,fwd.x),up=new THREE.Vector3(0,1,0);
  const neck=up.clone().multiplyScalar(.5).addScaledVector(right,-N),across=right.clone().multiplyScalar(.5).addScaledVector(up,N);
  obj.matrixAutoUpdate=false;
  obj.matrix.makeBasis(fwd,neck,across).scale(new THREE.Vector3(scale,scale,scale));
  obj.matrix.setPosition(origin.clone().addScaledVector(fwd,pose.anchor[0]*scale).addScaledVector(right,pose.anchor[1]*scale).addScaledVector(up,pose.anchor[2]*scale));
  obj.matrixWorldNeedsUpdate=true;obj.visible=pose.weight>0;
}

/** Preserve the attained idle underlay through an interrupted entry; all inputs are observed clocks. */
export function guitarIdleUnderlay(age:number|undefined,entry:number,normal:number,released?:number,duration?:number){
  const smooth=(x:number)=>{const k=Math.max(0,Math.min(1,x));return k*k*(3-2*k);};
  if(released===undefined)return (1-smooth((age??GUITAR_FADE)/GUITAR_FADE))*entry;
  const r=smooth(released/GUITAR_FADE),d=smooth((duration??GUITAR_FADE)/GUITAR_FADE);
  return (1-r)*(1-d)*entry+r*normal;
}

/** Native owners observed by the guitar release adapter; these remain authoritative. */
export const GUITAR_OWNER_FIELDS=['hands','grip','handHold','rps','heldItemsV1','on'] as const;
export function guitarOwnerStamp(value:unknown):string|undefined{
  if(!value)return undefined;
  const stamp=JSON.stringify(value);return stamp==='{}'||stamp==='[]'?undefined:stamp;
}
