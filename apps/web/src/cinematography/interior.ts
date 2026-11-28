/** A bounded room view proposal. It never writes a camera, actor, or scene. */
import {Matrix4,Vector3,type PerspectiveCamera} from 'three';
import {prepareCutFrame} from './transitions.ts';
import type {EnclosureResult,NearbyOpeningContext} from './enclosure.ts';
import type {FollowGeometry,Sight,PresentSubject,FollowViewport,FollowProjection} from './follow-camera.ts';
export type InteriorDiagnostic={status:string;key:string|null;anchor:number[]|null;proposal:number[]|null;visibility:Sight|null;passage:Sight|null;tested:number;retreat:string;validation:'full-authored-building-surfaces-and-current-obstacles';containment:'unproved';stage?:{status:string;target:number[]|null;executed:boolean;ready:boolean;benefit:boolean}};
export class InteriorView{
 private retreatPlan:{root:Vector3;eye:Vector3;axis:Vector3;progress:number}|null=null;private nextRetreat=0;
 private key='';private region:EnclosureResult['region']=null;private anchor:Vector3|null=null;private proposals:Vector3[]=[];private cursor=0;private next=0;private retried=false;
 diagnostic:InteriorDiagnostic=this.blank();
 private blank():InteriorDiagnostic{return{status:'inactive',key:null,anchor:null,proposal:null,visibility:null,passage:null,tested:0,retreat:this.retreatPlan?'prepared':'inactive',validation:'full-authored-building-surfaces-and-current-obstacles',containment:'unproved'};}
 discardRetreat(){this.retreatPlan=null;this.nextRetreat=0;}
 destination(){return this.anchor?{eye:this.anchor.clone(),key:this.key}:null;}
 reset(){this.retreatPlan=null;this.nextRetreat=0;this.key='';this.region=null;this.anchor=null;this.proposals=[];this.cursor=0;this.next=0;this.retried=false;this.diagnostic=this.blank();}
 install(context:NearbyOpeningContext,eye:Vector3,generation:number){this.sync(null,false,generation,context);this.anchor=eye.clone();this.diagnostic={...this.diagnostic,status:'cut-anchor',anchor:eye.toArray()};}
 sync(context:EnclosureResult|null|undefined,manual:boolean,generation:number,held?:NearbyOpeningContext){
  const selected=context?.status==='enclosed'?context:held;
  if(manual||!selected?.region||!selected.worldMatrix){this.reset();this.diagnostic.status=manual?'manual':'inactive';return null;}
  const roomContext=selected;const key=interiorContextKey(roomContext,generation);
  if(key!==this.key||roomContext.region!==this.region){this.reset();this.key=key;this.region=roomContext.region;const r=selected.region,m=new Matrix4().fromArray(selected.worldMatrix),centre=new Vector3();for(const p of r.poly){centre.x+=p[0]/r.poly.length;centre.z+=p[1]/r.poly.length;}centre.y=r.y+Math.min(1.6,r.height*.55);
   // Opening-adjacent exterior proposals first. Direction from room centre is
   // only a placement heuristic, never a portal normal/connectivity guarantee.
   for(const o of roomContext.openingProposals??[]){if(o.at.length!==2||!o.at.every(Number.isFinite))continue;const opening=new Vector3(o.at[0],centre.y,o.at[1]),world=opening.clone().applyMatrix4(m),outward=world.clone().sub(new Vector3(centre.x,opening.y,centre.z).applyMatrix4(m));outward.y=0;if(outward.lengthSq()<1e-8)continue;world.addScaledVector(outward.normalize(),1.2);world.y=new Vector3(centre.x,centre.y,centre.z).applyMatrix4(m).y;this.proposals.push(world);}
   // At most eight perimeter proposals plus the retained bounded centre proposals.
   // Concave polygons may put these outside: geometry/visibility never infer validity.
   for(let i=0;i<Math.min(8,r.poly.length);i++){const p=r.poly[Math.floor(i*r.poly.length/Math.min(8,r.poly.length))],v=new Vector3(p[0],centre.y,p[1]).lerp(centre,.25);this.proposals.push(v.applyMatrix4(m));}
   for(const p of roomContext.proposals.slice(0,9))this.proposals.push(new Vector3().fromArray(p));
  }
  this.diagnostic={...this.blank(),status:this.anchor?'holding':'searching',key:this.key,anchor:this.anchor?.toArray()??null};return this.anchor?.clone()??null;
 }
 // A current-observation framing cue prepares translation, never actor motion or a cut.
 prepareRetreat(clock:number,subject:PresentSubject,camera:PerspectiveCamera,eye:Vector3,viewport:FollowViewport|undefined,projection:FollowProjection|undefined,check:{geometry:FollowGeometry;points:readonly Vector3[];radius:(eye:Vector3)=>number|null;ground:(x:number,z:number)=>number|null}){
  if(!this.anchor)return;
  const travel=subject.travelMps,root=new Vector3().fromArray(subject.transform.positionM);
  if(!travel||!Number.isFinite(travel.confidence)||travel.confidence<.5||!travel.value.every(Number.isFinite)){this.retreatPlan=null;this.diagnostic.retreat='observation-unknown';return;}
  const velocity=new Vector3().fromArray(travel.value);if(velocity.length()>4){this.retreatPlan=null;this.diagnostic.retreat='discontinuity';return;}velocity.y=0;const speed=velocity.length();
  if(clock<this.nextRetreat)return;this.nextRetreat=clock+.25;
  if(!this.retreatPlan){
   if(speed<.1||eye.distanceTo(this.anchor)>.25)return;
   const axis=this.anchor.clone().sub(root);axis.y=0;if(axis.lengthSq()<1e-8||velocity.dot(axis.normalize())<.1)return;
   // Null means unavailable/currently infeasible, not a predicted framing loss.
   const frame=prepareCutFrame(subject,camera,this.anchor,viewport,projection);
   if(!frame){this.diagnostic.retreat='framing-unavailable';return;}
   if(frame.usefulDwell>=2)return;
   this.retreatPlan={root:root.clone(),eye:this.anchor.clone(),axis,progress:0};
  }
  const plan=this.retreatPlan,forward=velocity.dot(plan.axis);
  if(forward<.1){this.diagnostic.retreat='holding-reversal-or-stop';return;}
  // Fixed direction and monotonic observed progress prevent reversing into the
  // doorway. The bounded lead compensates existing .8s translation damping.
  const progress=Math.max(0,root.clone().sub(plan.root).dot(plan.axis))+Math.min(1.5,forward*.8);
  const nextProgress=Math.max(plan.progress,progress),proposed=plan.eye.clone().addScaledVector(plan.axis,nextProgress),y=check.ground(proposed.x,proposed.z),r=check.radius(proposed);
  this.diagnostic.proposal=proposed.toArray();this.diagnostic.tested=1;
  if(y===null||!Number.isFinite(y)||r===null){this.diagnostic.retreat='target-unknown';return true;}
  if(proposed.y<y+1.2){this.diagnostic.retreat='target-below-ground';return true;}
  for(const p of check.points){const sight=check.geometry.segmentAuthored(proposed,p,0,true);this.diagnostic.visibility=sight;if(sight!=='clear'){this.diagnostic.retreat='target-'+sight;return true;}}
  const envelope=check.geometry.segmentAuthored(proposed,proposed,r);if(envelope!=='clear'){this.diagnostic.retreat='target-'+envelope;return true;}
  plan.progress=nextProgress;this.anchor.copy(proposed);this.diagnostic.anchor=this.anchor.toArray();this.diagnostic.retreat='advancing';return true;
 }
 search(clock:number,eye:Vector3,points:readonly Vector3[],geometry:FollowGeometry,radius:(eye:Vector3)=>number|null,ground:(x:number,z:number)=>number|null){
  if(!this.key||clock<this.next)return;this.next=clock+.25;const d=this.diagnostic;
  // Authored glass may transmit a ray but veil the body in pixels. Interior
  // proposals conservatively reject it; two anchors still do not prove body extent.
  const sight=(eye:Vector3):Sight=>{for(const p of points){const s=geometry.segmentAuthored(eye,p,0,true);if(s!=='clear')return s;}return'clear';};
  // Destination validity is separate from the still-occluded transit view. Keep
  // one target through a safe approach; never restart selection every search tick.
  if(this.anchor){const r=radius(this.anchor);d.visibility=sight(this.anchor);if(r===null||d.visibility==='unknown'){d.status='anchor-unknown';return;}const envelope=d.visibility==='clear'?geometry.segmentAuthored(this.anchor,this.anchor,r):'blocked';if(envelope==='unknown'){d.status='anchor-unknown';return;}if(d.visibility==='clear'&&envelope==='clear'&&this.anchor.distanceTo(points[0])>=2){d.status='holding';d.anchor=this.anchor.toArray();return;}this.anchor=null;this.retreatPlan=null;d.anchor=null;}
  // Keep a readable exterior or previously selected room-world eye. This is the
  // actual eye, not the old outdoor root-relative goal.
  d.visibility=sight(eye);if(d.visibility==='unknown'){d.status='visibility-unknown';return;}
  if(d.visibility==='clear'&&eye.distanceTo(points[0])>=2){this.retried=false;if(!this.anchor)this.anchor=eye.clone();d.anchor=this.anchor.toArray();d.status='holding';return;}
  this.anchor=null;d.anchor=null;if(!this.proposals.length){d.status='no-proposals';return;}
  const proposal=this.proposals[this.cursor%this.proposals.length],advance=()=>{this.cursor++;this.retried=false;},unknown=()=>{if(this.retried)advance();else this.retried=true;};d.proposal=proposal.toArray();d.tested=1;
  const r=radius(proposal),y=ground(proposal.x,proposal.z);if(r===null||y===null||!Number.isFinite(y)){d.status='proposal-unavailable';unknown();return;}
  if(proposal.y<y+1.2||proposal.distanceTo(points[0])<2){d.status='proposal-shot-too-close';advance();return;}
  const envelope=geometry.segmentAuthored(proposal,proposal,r);if(envelope!=='clear'){d.status=envelope==='unknown'?'proposal-unknown':'proposal-surface-overlap';if(envelope==='unknown')unknown();else advance();return;}
  d.visibility=sight(proposal);if(d.visibility!=='clear'){d.status=d.visibility==='unknown'?'proposal-unknown':'proposal-occluded';if(d.visibility==='unknown')unknown();else advance();return;}
  d.passage=geometry.segmentAuthored(eye,proposal,r);if(d.passage!=='clear'){d.status=d.passage==='unknown'?'passage-unknown':'readable-proposal-unreachable';if(d.passage==='unknown')unknown();else advance();return;}
  advance();this.anchor=proposal.clone();d.anchor=proposal.toArray();d.status='selected';
 }
}

/** Metadata only proposes a destination. Current represented geometry admits it. */
export const DOOR_STAGE_LIMITS=Object.freeze({closing:.25,minDepth:4,maxDepth:8,tangentSeconds:1.5,tangent:2,forecastSeconds:1.5,forecastDistance:2});
export function interiorContextKey(context:Pick<EnclosureResult,'building'|'room'|'floor'|'revision'|'sourceRevision'|'worldMatrix'>,generation:number){return JSON.stringify([context.building,context.room,context.floor,context.revision,context.sourceRevision,context.worldMatrix,generation]);}
export function hasStageOpening(context:NearbyOpeningContext,key:string){return context.openingProposals.some(o=>(o.kind==='door'||o.kind==='arch')&&JSON.stringify(o)===key);}
export type DoorStage={eye:Vector3;direction:Vector3;context:NearbyOpeningContext;roomKey:string;openingKey:string;executed:boolean;entered:boolean};
export function proposeDoorStage(context:NearbyOpeningContext,eye:Vector3,root:Vector3,travel:Vector3,generation:number):DoorStage|null{
 const openings=context.openingProposals.filter(o=>o.kind==='door'||o.kind==='arch');
 if(openings.length!==1||context.worldMatrix.length!==16||!context.worldMatrix.every(Number.isFinite)||!context.region?.poly.length||![...eye,...root,...travel].every(Number.isFinite)||travel.length()>4)return null;
 const o=openings[0],r=context.region,m=new Matrix4().fromArray(context.worldMatrix);if(![r.y,r.height,o.width,o.height,o.sill].every(Number.isFinite)||r.height<=0||o.width<=0||o.height<=0||Math.abs(m.determinant())<1e-10||o.at.length!==2||!o.at.every(Number.isFinite)||o.floor!==context.floor)return null;
 const centre=new Vector3();for(const p of r.poly){if(p.length!==2||!p.every(Number.isFinite))return null;centre.x+=p[0]/r.poly.length;centre.z+=p[1]/r.poly.length;}centre.y=r.y+Math.min(1.6,r.height*.55);
 const opening=new Vector3(o.at[0],centre.y,o.at[1]).applyMatrix4(m),worldCentre=centre.applyMatrix4(m),outward=opening.clone().sub(worldCentre);outward.y=0;
 const closing=opening.clone().sub(root);closing.y=0;if(outward.lengthSq()<1e-8||closing.lengthSq()<1e-8||travel.dot(closing.normalize())<=DOOR_STAGE_LIMITS.closing)return null;
 outward.normalize();const tangent=new Vector3(-outward.z,0,outward.x),depth=Math.max(DOOR_STAGE_LIMITS.minDepth,Math.min(DOOR_STAGE_LIMITS.maxDepth,eye.clone().sub(opening).dot(outward))),bias=Math.max(-DOOR_STAGE_LIMITS.tangent,Math.min(DOOR_STAGE_LIMITS.tangent,-travel.dot(tangent)*DOOR_STAGE_LIMITS.tangentSeconds));
 const destination=opening.clone().addScaledVector(outward,depth).addScaledVector(tangent,bias);destination.y=worldCentre.y;if(![...destination].every(Number.isFinite))return null;
 return{eye:destination,direction:travel.clone().setY(0).normalize(),context,roomKey:interiorContextKey(context,generation),openingKey:JSON.stringify(o),executed:false,entered:false};
}
/** All safety answers belong to this call. A forecast is only an execution cue. */
export function checkDoorStage(stage:DoorStage,subject:PresentSubject,camera:PerspectiveCamera,eye:Vector3,points:readonly Vector3[],travel:Vector3,geometry:FollowGeometry,radius:number|null,ground:(x:number,z:number)=>number|null,viewport?:FollowViewport,projection?:FollowProjection){
 const frame=prepareCutFrame(subject,camera,stage.eye,viewport,projection),y=ground(stage.eye.x,stage.eye.z);
 if(!frame||radius===null||y===null||!Number.isFinite(y)||stage.eye.y<y+1.2)return{ready:false,admitted:false,benefit:false,frame,occupancy:'stage-framing-or-ground-unavailable'};
 const present=points.map(p=>geometry.segmentAuthored(stage.eye,p,0,true));
 const future=points[0].clone().add(travel.clone().multiplyScalar(DOOR_STAGE_LIMITS.forecastSeconds).clampLength(0,DOOR_STAGE_LIMITS.forecastDistance));
 const targetFuture=geometry.segmentAuthored(stage.eye,future,0,true),incumbentFuture=geometry.segmentAuthored(eye,future,0,true),occupancy=geometry.exteriorWitness(stage.eye,radius);
 const admitted=present.every(s=>s==='clear')&&targetFuture==='clear'&&incumbentFuture!=='unknown'&&occupancy.status==='clear';
 return{ready:admitted&&frame.usefulDwell>=2,admitted,benefit:incumbentFuture==='blocked'&&targetFuture==='clear',frame,occupancy:occupancy.reason};
}
