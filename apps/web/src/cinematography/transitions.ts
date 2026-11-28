/** One discretionary-cut history. Resetting a camera only clears preparation. */
import {PerspectiveCamera,Quaternion,Vector3} from 'three';
import {composeVisibleViewport,visibleViewport} from '../WorldViewport.ts';
import {fitNearPlane} from '../../../../mars/viewer/lib/depth-fit.ts';
import type {PresentSubject,FollowProjection,FollowViewport} from './follow-camera.ts';
export const CUT_LIMITS=Object.freeze({spacing:20,window:60,count:2,persistence:.75,usefulDwell:2,checkInterval:.25,preparationGap:.4});
export type CutDiagnostic={status:string;executed:boolean;total:number;history:number[];preparedSeconds:number;usefulDwell:number;occupancy:string;destination:number[]|null;beforeDirection:number[]|null;afterDirection:number[]|null};
export class CutAuthority{
 private history:number[]=[];private total=0;private key='';private since=0;private checked=-Infinity;private time=-Infinity;
 diagnostic:CutDiagnostic={status:'inactive',executed:false,total:0,history:[],preparedSeconds:0,usefulDwell:0,occupancy:'unknown',destination:null,beforeDirection:null,afterDirection:null};
 clear(){this.key='';this.since=0;this.checked=-Infinity;}
 direction(before:readonly number[],after:readonly number[]){this.diagnostic={...this.diagnostic,beforeDirection:[...before],afterDirection:[...after]};}
 begin(){this.diagnostic={...this.diagnostic,executed:false};}
 refuse(reason:string){this.clear();this.diagnostic={...this.diagnostic,status:reason,executed:false,preparedSeconds:0};return false;}
 consider(now:number,key:string,ready:boolean,usefulDwell:number,destination:readonly number[],occupancy:string){
  this.diagnostic={...this.diagnostic,executed:false,usefulDwell,occupancy,destination:[...destination]};
  if(!Number.isFinite(now)||now<this.time)return this.refuse('cut-clock-invalid');this.time=now;
  this.history=this.history.filter(t=>now-t<CUT_LIMITS.window);this.diagnostic.history=[...this.history];
  if(!ready||!Number.isFinite(usefulDwell)||usefulDwell<CUT_LIMITS.usefulDwell)return this.refuse('cut-not-ready');
  if(key!==this.key||now-this.checked>CUT_LIMITS.preparationGap){this.key=key;this.since=now;}this.checked=now;this.diagnostic.preparedSeconds=now-this.since;
  if(this.history.length>=CUT_LIMITS.count||this.history.length&&now-this.history.at(-1)!<CUT_LIMITS.spacing){this.diagnostic.status='cut-rate-limited';return false;}
  if(now-this.since+1e-9<CUT_LIMITS.persistence){this.diagnostic.status='cut-preparing';return false;}
  this.history.push(now);this.total++;this.diagnostic={...this.diagnostic,status:'cut-executed',executed:true,total:this.total,history:[...this.history]};this.clear();return true;
 }
}
/** Private prospective framing; no shared camera/matrix/scene writes. */
export function prepareCutFrame(subject:PresentSubject,source:PerspectiveCamera,eye:Vector3,viewport?:FollowViewport,projection?:FollowProjection){
 if(!subject.bounds||source.parent||!viewport||!projection)return null;
 const area=visibleViewport(viewport.width,viewport.height,viewport.insets);if(!area)return null;
 const bounds=subject.bounds,q=new Quaternion().fromArray(subject.transform.rotationXyzw),root=new Vector3().fromArray(subject.transform.positionM),centre=new Vector3().fromArray(bounds.min).add(new Vector3().fromArray(bounds.max)).multiplyScalar(.5).applyQuaternion(q).add(root);
 const next=new PerspectiveCamera().copy(source,false);next.position.copy(eye);if(!composeVisibleViewport(next,projection.width,projection.height,projection.insets,projection.fov))return null;
 const safe={left:2*area.left/viewport.width-1+.03,right:2*(area.left+area.width)/viewport.width-1-.03,bottom:1-2*(area.top+area.height)/viewport.height+.03,top:1-2*area.top/viewport.height-.03};
 const aim=centre.clone();next.lookAt(aim);next.updateMatrixWorld(true);const depth=eye.distanceTo(centre),vertical=depth*Math.tan(next.fov*Math.PI/360),up=new Vector3(0,1,0).applyQuaternion(next.quaternion),right=new Vector3(1,0,0).applyQuaternion(next.quaternion);
 aim.addScaledVector(up,-(safe.top+safe.bottom)/2*vertical).addScaledVector(right,-(safe.left+safe.right)/2*vertical*next.aspect);next.lookAt(aim);next.updateMatrixWorld(true);fitNearPlane(next);
 const fits=(shift:Vector3)=>{for(let i=0;i<8;i++){const p=new Vector3(i&1?bounds.max[0]:bounds.min[0],i&2?bounds.max[1]:bounds.min[1],i&4?bounds.max[2]:bounds.min[2]).applyQuaternion(q).add(root).add(shift),local=p.clone().applyMatrix4(next.matrixWorldInverse);if(-local.z<=next.near)return false;p.project(next);if(![...p].every(Number.isFinite)||p.z>1||p.x<safe.left||p.x>safe.right||p.y<safe.bottom||p.y>safe.top)return false;}return true;};
 if(!fits(new Vector3()))return null;
 const travel=subject.travelMps;if(!travel||!Number.isFinite(travel.confidence)||travel.confidence<.5||!travel.value.every(Number.isFinite))return null;
 const velocity=new Vector3().fromArray(travel.value);if(velocity.length()>4)return null;
 // An estimate from current observed motion only, never a future recorded pose.
 const usefulDwell=fits(velocity.multiplyScalar(CUT_LIMITS.usefulDwell))?CUT_LIMITS.usefulDwell:0;
 return{eye:eye.clone(),aim,usefulDwell,projection:next.projectionMatrix.toArray()};
}
