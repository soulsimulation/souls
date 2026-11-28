/** Authored room context only. No collision, visibility, leaf-state or connectivity certification. */
import {Matrix4,Vector3} from 'three';
import type {Object3D} from 'three';
export type AuthoredRoom=Readonly<{id:string;floor:number;y:number;height:number;poly:readonly (readonly number[])[]}>;
type Room=AuthoredRoom;
export type AuthoredOpening={kind:'door'|'window'|'arch';floor:number;at:readonly [number,number];width:number;height:number;sill:number;from:string|null;to:string|null};
type Hints={schema:string;revision:string;reason?:string;extent?:readonly number[]|null;open:boolean;rooms:readonly Room[];openings:readonly AuthoredOpening[]};
export const ENCLOSURE_LIMITS=Object.freeze({buildings:64,rooms:32,edges:2048,entry:.15,exit:.15,proposalMargin:.4,approach:5});
export type NearbyOpeningContext={building:string;revision:string;sourceRevision:string;room:string;floor:number;canonical:number[];worldMatrix:number[];region:AuthoredRoom;openingProposals:readonly AuthoredOpening[];proposals:number[][]};
export type EnclosureResult={nearby?:NearbyOpeningContext|null;status:string;reason:string;building:string|null;revision:string|null;sourceRevision:string|null;room:string|null;floor:number|null;canonical:number[]|null;worldMatrix:number[]|null;region:AuthoredRoom|null;proposalMarginM:number;openingProposals:readonly AuthoredOpening[];proposals:number[][];openings:Record<string,number>;connectivity:'unknown';validation:'full-authored-geometry-required';work:{buildings:number;rooms:number;edges:number};retained:number};
const blank=(reason:string):EnclosureResult=>({status:'unknown',reason,building:null,revision:null,sourceRevision:null,room:null,floor:null,canonical:null,worldMatrix:null,region:null,proposalMarginM:ENCLOSURE_LIMITS.proposalMargin,openingProposals:[],proposals:[],openings:{door:0,window:0,arch:0},connectivity:'unknown',validation:'full-authored-geometry-required',work:{buildings:0,rooms:0,edges:0},retained:0});
/** Signed distance to the polygon boundary; positive inside. */
function polygon(point:Vector3,poly:readonly (readonly number[])[],budget:{edges:number},matrix?:Matrix4){
 let inside=false,distance=Infinity;const world=matrix?point.clone().applyMatrix4(matrix):null;
 for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  if(budget.edges>=ENCLOSURE_LIMITS.edges)return null;budget.edges++;const a=poly[j],b=poly[i];if(a.length!==2||b.length!==2||![...a,...b].every(Number.isFinite))return null;
  if((a[1]>point.z)!==(b[1]>point.z)&&point.x<(b[0]-a[0])*(point.z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  const dx=b[0]-a[0],dz=b[1]-a[1],n=dx*dx+dz*dz,t=n?Math.max(0,Math.min(1,((point.x-a[0])*dx+(point.z-a[1])*dz)/n)):0;if(matrix&&world){const wa=new Vector3(a[0],point.y,a[1]).applyMatrix4(matrix),wb=new Vector3(b[0],point.y,b[1]).applyMatrix4(matrix),d=wb.sub(wa),t=d.lengthSq()?Math.max(0,Math.min(1,world.clone().sub(wa).dot(d)/d.lengthSq())):0;distance=Math.min(distance,world.distanceTo(wa.addScaledVector(d,t)));}else distance=Math.min(distance,Math.hypot(point.x-a[0]-t*dx,point.z-a[1]-t*dz));
 }
 return inside?distance:-distance;
}
export class EnclosureContext{
 private prior:{node:Object3D;hints:Hints;matrix:number[];room:string;revision:string}|null=null;
 reset(){this.prior=null;}
 resolve(source:{nodes:readonly Object3D[];complete:boolean;revision:string},position:readonly number[]):EnclosureResult{
  const out=blank('metadata-unavailable');if(!source.complete||source.nodes.length>ENCLOSURE_LIMITS.buildings||position.length!==3||!position.every(Number.isFinite)){this.reset();out.reason='collection-or-subject-unavailable';return out;}
  if(!source.nodes.length){this.reset();return out;}out.sourceRevision=source.revision;
  const world=new Vector3().fromArray(position),inverse=new Matrix4();let found:{node:Object3D;h:Hints;r:Room;local:Vector3;distance:number}[]=[];let uncertain=false,unsupported=false;let nearby:{node:Object3D;h:Hints;r:Room;local:Vector3;opening:AuthoredOpening;distance:number}|null=null,nearbySecond=Infinity;
  for(const node of source.nodes){out.work.buildings++;const h=node.userData.cameraEnclosure as Hints,m=node.matrixWorld;
   if(!m.elements.every(Number.isFinite)||Math.abs(m.determinant())<1e-10){uncertain=true;unsupported=true;continue;}
   inverse.copy(m).invert();const local=world.clone().applyMatrix4(inverse),ie=inverse.elements,margin=ENCLOSURE_LIMITS.approach*Math.hypot(ie[0],ie[1],ie[2],ie[4],ie[5],ie[6],ie[8],ie[9],ie[10]),vertical=Math.hypot(ie[1],ie[5],ie[9]);
   if(h?.extent?.length===6&&h.extent.every(Number.isFinite)){const e=h.extent;if(local.x<e[0]-margin||local.z<e[2]-margin||local.x>e[3]+margin||local.z>e[5]+margin||local.y<e[1]-.25*vertical||local.y>e[4]+.25*vertical)continue;}
   if(h?.schema!=='building-camera/1'||h.reason||!Array.isArray(h.rooms)||h.rooms.length>32||!Array.isArray(h.openings)||h.openings.length>128){uncertain=true;unsupported=true;continue;}
   const prior=this.prior,same=prior?.node===node&&prior.hints===h&&prior.revision===source.revision&&prior.matrix.every((v,i)=>v===m.elements[i]);
   for(const r of h.rooms){out.work.rooms++;if(!Number.isFinite(r.y)||!Number.isFinite(r.height)||r.height<=0||!Number.isInteger(r.floor)||!Array.isArray(r.poly)||r.poly.length<3||r.poly.length>64){uncertain=true;unsupported=true;continue;}
    if(local.y<r.y-.25*vertical||local.y>r.y+r.height-.1*vertical)continue;
    // Cheap local box rejects distant rooms before polygon work. No scene traversal.
    let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;for(const p of r.poly){if(out.work.edges>=ENCLOSURE_LIMITS.edges){this.reset();out.reason='context-work-cap';return out;}out.work.edges++;if(p.length!==2||!p.every(Number.isFinite)){this.reset();out.reason='invalid-room-polygon';return out;}x0=Math.min(x0,p[0]);x1=Math.max(x1,p[0]);z0=Math.min(z0,p[1]);z1=Math.max(z1,p[1]);}
    if(local.x<x0-margin||local.x>x1+margin||local.z<z0-margin||local.z>z1+margin)continue;
    const d=polygon(local,r.poly,out.work,m);if(d===null){this.reset();out.reason='context-work-cap-or-invalid';return out;}
    const keep=same&&prior?.room===r.id;if(d>=(keep?-ENCLOSURE_LIMITS.exit:ENCLOSURE_LIMITS.entry))found.push({node,h,r,local,distance:d});else if(d>=-ENCLOSURE_LIMITS.exit)uncertain=true;
    if(d<ENCLOSURE_LIMITS.entry&&!h.open)for(const o of h.openings){
     if(out.work.edges>=ENCLOSURE_LIMITS.edges){this.reset();out.reason='context-work-cap';return out;}out.work.edges++;
     if(o.kind!=='door'&&o.kind!=='arch'||o.floor!==r.floor||!(o.from===r.id||o.to===r.id||o.from===null&&o.to===null)||!Array.isArray(o.at)||o.at.length!==2||!o.at.every(Number.isFinite))continue;
     const point=new Vector3(o.at[0],local.y,o.at[1]).applyMatrix4(m),distance=world.distanceTo(point);if(distance>ENCLOSURE_LIMITS.approach)continue;
     if(!nearby||distance<nearby.distance){nearbySecond=nearby?.distance??Infinity;nearby={node,h,r,local,opening:o,distance};}else nearbySecond=Math.min(nearbySecond,distance);
    }
   }
  }
  if(found.length!==1||uncertain){this.reset();out.status=found.length||uncertain?'ambiguous':'outside';out.reason=found.length>1?'overlapping-room-context':uncertain?'boundary-or-unsupported-metadata':'outside-examined-authored-rooms';
   if(!found.length&&!unsupported&&nearby&&nearbySecond-nearby.distance>=.25){const n=nearby;out.nearby={building:String(n.node.userData.cameraEnclosureId??n.node.parent?.name??n.node.name).slice(0,96),revision:n.h.revision,sourceRevision:source.revision,room:n.r.id,floor:n.r.floor,canonical:n.local.toArray(),worldMatrix:[...n.node.matrixWorld.elements],region:n.r,openingProposals:[n.opening],proposals:[]};}
   return out;}
  const {node,h,r,local,distance}=found[0];this.prior={node,hints:h,matrix:[...node.matrixWorld.elements],room:r.id,revision:source.revision};
  out.status=h.open?'open':'enclosed';out.reason=distance<ENCLOSURE_LIMITS.entry?'boundary-held':'authored-membership';out.building=String(node.userData.cameraEnclosureId??node.parent?.name??node.name).slice(0,96);out.revision=h.revision;out.room=r.id;out.floor=r.floor;out.canonical=local.toArray();out.worldMatrix=[...node.matrixWorld.elements];out.retained=1;out.region=r;out.openingProposals=h.openings.filter(o=>o.floor===r.floor&&(o.from===r.id||o.to===r.id||o.from===null&&o.to===null)).sort((a,b)=>Number(a.kind==='window')-Number(b.kind==='window')).slice(0,8);
  for(const o of h.openings)if(o.floor===r.floor&&(o.from===r.id||o.to===r.id)&&Object.hasOwn(out.openings,o.kind))out.openings[o.kind]++;
  let x=0,z=0;for(const p of r.poly){x+=p[0]/r.poly.length;z+=p[1]/r.poly.length;}
  for(const dx of[-.5,0,.5])for(const dz of[-.5,0,.5]){const p=new Vector3(x+dx,r.y+Math.min(1.6,r.height-.4),z+dz),d=polygon(p,r.poly,out.work,node.matrixWorld);if(d===null){out.proposals=[];out.reason+=':proposal-work-cap';return out;}if(d>=ENCLOSURE_LIMITS.proposalMargin)out.proposals.push(p.applyMatrix4(node.matrixWorld).toArray());}
  return out;
 }
}
