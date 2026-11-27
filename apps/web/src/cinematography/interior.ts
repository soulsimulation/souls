/** A bounded room view proposal. It never writes a camera, actor, or scene. */
import {Matrix4,Vector3} from 'three';
import type {EnclosureResult} from './enclosure.ts';
import type {FollowGeometry,Sight} from './follow-camera.ts';
export type InteriorDiagnostic={status:string;key:string|null;anchor:number[]|null;proposal:number[]|null;visibility:Sight|null;passage:Sight|null;tested:number;validation:'full-authored-building-surfaces-and-current-obstacles';containment:'unproved'};
export class InteriorView{
 private key='';private region:EnclosureResult['region']=null;private anchor:Vector3|null=null;private proposals:Vector3[]=[];private cursor=0;private next=0;
 diagnostic:InteriorDiagnostic=this.blank();
 private blank():InteriorDiagnostic{return{status:'inactive',key:null,anchor:null,proposal:null,visibility:null,passage:null,tested:0,validation:'full-authored-building-surfaces-and-current-obstacles',containment:'unproved'};}
 reset(){this.key='';this.region=null;this.anchor=null;this.proposals=[];this.cursor=0;this.next=0;this.diagnostic=this.blank();}
 sync(context:EnclosureResult|null|undefined,manual:boolean,generation:number){
  if(manual||context?.status!=='enclosed'||!context.region||!context.worldMatrix){this.reset();this.diagnostic.status=manual?'manual':'inactive';return null;}
  const key=JSON.stringify([context.building,context.room,context.floor,context.revision,context.sourceRevision,context.worldMatrix,generation]);
  if(key!==this.key||context.region!==this.region){this.reset();this.key=key;this.region=context.region;const r=context.region,m=new Matrix4().fromArray(context.worldMatrix),centre=new Vector3();for(const p of r.poly){centre.x+=p[0]/r.poly.length;centre.z+=p[1]/r.poly.length;}centre.y=r.y+Math.min(1.6,r.height*.55);
   // Opening-adjacent exterior proposals first. Direction from room centre is
   // only a placement heuristic, never a portal normal/connectivity guarantee.
   for(const o of context.openingProposals??[]){if(o.at.length!==3||!o.at.every(Number.isFinite))continue;const opening=new Vector3().fromArray(o.at),world=opening.clone().applyMatrix4(m),outward=world.clone().sub(new Vector3(centre.x,opening.y,centre.z).applyMatrix4(m));outward.y=0;if(outward.lengthSq()<1e-8)continue;world.addScaledVector(outward.normalize(),1.2);world.y=new Vector3(centre.x,centre.y,centre.z).applyMatrix4(m).y;this.proposals.push(world);}
   // At most eight perimeter proposals plus the retained bounded centre proposals.
   // Concave polygons may put these outside: geometry/visibility never infer validity.
   for(let i=0;i<Math.min(8,r.poly.length);i++){const p=r.poly[Math.floor(i*r.poly.length/Math.min(8,r.poly.length))],v=new Vector3(p[0],centre.y,p[1]).lerp(centre,.25);this.proposals.push(v.applyMatrix4(m));}
   for(const p of context.proposals.slice(0,9))this.proposals.push(new Vector3().fromArray(p));
  }
  this.diagnostic={...this.blank(),status:this.anchor?'holding':'searching',key:this.key,anchor:this.anchor?.toArray()??null};return this.anchor?.clone()??null;
 }
 search(clock:number,eye:Vector3,points:readonly Vector3[],geometry:FollowGeometry,radius:(eye:Vector3)=>number|null,ground:(x:number,z:number)=>number|null){
  if(!this.key||clock<this.next)return;this.next=clock+.25;const d=this.diagnostic;
  const sight=(eye:Vector3):Sight=>{for(const p of points){const s=geometry.segmentAuthored(eye,p);if(s!=='clear')return s;}return'clear';};
  // Destination validity is separate from the still-occluded transit view. Keep
  // one target through a safe approach; never restart selection every search tick.
  if(this.anchor){const r=radius(this.anchor);d.visibility=sight(this.anchor);if(r===null||d.visibility==='unknown'){d.status='anchor-unknown';return;}const envelope=geometry.segmentAuthored(this.anchor,this.anchor,r);if(envelope==='unknown'){d.status='anchor-unknown';return;}if(d.visibility==='clear'&&envelope==='clear'&&this.anchor.distanceTo(points[0])>=2){d.status='holding';d.anchor=this.anchor.toArray();return;}this.anchor=null;d.anchor=null;}
  // Keep a readable exterior or previously selected room-world eye. This is the
  // actual eye, not the old outdoor root-relative goal.
  d.visibility=sight(eye);if(d.visibility==='unknown'){d.status='visibility-unknown';return;}
  if(d.visibility==='clear'){if(!this.anchor)this.anchor=eye.clone();d.anchor=this.anchor.toArray();d.status='holding';return;}
  this.anchor=null;d.anchor=null;if(!this.proposals.length){d.status='no-proposals';return;}
  const proposal=this.proposals[this.cursor++%this.proposals.length];d.proposal=proposal.toArray();d.tested=1;
  const r=radius(proposal),y=ground(proposal.x,proposal.z);if(r===null||y===null||!Number.isFinite(y)){d.status='proposal-unavailable';return;}
  if(proposal.y<y+1.2||proposal.distanceTo(points[0])<2){d.status='proposal-shot-too-close';return;}
  const envelope=geometry.segmentAuthored(proposal,proposal,r);if(envelope!=='clear'){d.status=envelope==='unknown'?'proposal-unknown':'proposal-surface-overlap';return;}
  d.visibility=sight(proposal);if(d.visibility!=='clear'){d.status=d.visibility==='unknown'?'proposal-unknown':'proposal-occluded';return;}
  d.passage=geometry.segmentAuthored(eye,proposal,r);if(d.passage!=='clear'){d.status=d.passage==='unknown'?'passage-unknown':'readable-proposal-unreachable';return;}
  this.anchor=proposal.clone();d.anchor=proposal.toArray();d.status='selected';
 }
}
