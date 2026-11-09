// Guitar geometry and palms share one torso frame. Its origin never follows the moving strumming wrist.
import * as THREE from 'three';
import { GUITAR_FADE, guitarFret, guitarStroke } from './piano-score.ts';
import {ik,palm,setWorldQuat,curlHand,swing,turn,type Arm} from './rig.ts';
/** Actor-local viewer failures: these never refuse or alter the native music action. */
export type GuitarViewerDiagnostic={
  code:'guitar.pose.unsupported-rig'|'guitar.pose.geometry-missing'|'guitar.pose.corridor-infeasible';
  side:'left'|'right';
  reason:string;
};
export type GuitarHandResult={target:THREE.Vector3|null;diagnostic?:GuitarViewerDiagnostic};
export type GuitarPose={anchor:readonly[number,number,number];weight:number;left:readonly[number,number,number];right:readonly[number,number,number]};
const N=.8660254037844386;
/** Local coordinates are [forward, right, up] from the supported body root. */
export function guitarPoint(p:readonly number[],anchor:readonly number[]):[number,number,number]{
  return [anchor[0]+p[0],anchor[1]-N*p[1]+.5*p[2],anchor[2]+.5*p[1]+N*p[2]];
}
export function guitarPose(seed:string,t:number,age?:number,released?:number,priorAge?:number):GuitarPose{
  const smooth=(x:number)=>{const k=Math.max(0,Math.min(1,x));return k*k*(3-2*k);};
  const w=released===undefined?smooth((age??GUITAR_FADE)/GUITAR_FADE):smooth((priorAge??GUITAR_FADE)/GUITAR_FADE)*(1-smooth(released/GUITAR_FADE));
  // Rest pose clears the measured native idle-hand envelope; held/strumming pose is unchanged.
  const phase=.5-Math.sin(Math.asin(Math.max(-1,Math.min(1,1-2*w)))/3);
  const anchor:[number,number,number]=[.25+.012*(1-smooth(phase/.2)),.10+(1-w)*.20,1.03-(1-w)*.23];
  return {anchor,weight:w,left:guitarPoint([.059,guitarFret(seed,t),-.0045],anchor),right:guitarPoint([.059,.04,guitarStroke(seed,t)*.058-.0045],anchor)};
}

type TipSurface={mesh:THREE.SkinnedMesh;indices:number[]}[];
const tips=new WeakMap<Arm,TipSurface>(),V=()=>new THREE.Vector3();
/** Only an active guitar measures its distal finger skin. Geometry indices are bound once per arm. */
function tipSurface(arm:Arm,model:THREE.Object3D):TipSurface{
  let refs=tips.get(arm);if(refs)return refs;refs=[];
  const names=new Set(arm.fingers.filter((_,i)=>i%4===3).map(o=>o.name));
  model.traverse(o=>{const mesh=o as THREE.SkinnedMesh;if(!mesh.isSkinnedMesh)return;
    const si=mesh.geometry.attributes.skinIndex,sw=mesh.geometry.attributes.skinWeight,indices:number[]=[];
    for(let i=0;i<si.count;i++){let k=0;for(let j=1;j<4;j++)if(sw.getComponent(i,j)>sw.getComponent(i,k))k=j;if(names.has(mesh.skeleton.bones[si.getComponent(i,k)]?.name))indices.push(i);}
    if(indices.length)refs!.push({mesh,indices});
  });tips.set(arm,refs);return refs;
}

type HandSurface={mesh:THREE.SkinnedMesh;indices:number[]}[];
const hands=new WeakMap<Arm,HandSurface>(),propBounds=new WeakMap<THREE.Object3D,THREE.Box3>();
function wholeHand(arm:Arm,model:THREE.Object3D):HandSurface{
 let refs=hands.get(arm);if(refs)return refs;refs=[];const names=new Set([arm.hand,...arm.fingers,...arm.thumb].map(o=>o.name));
 model.traverse(o=>{const m=o as THREE.SkinnedMesh;if(!m.isSkinnedMesh)return;const g=m.geometry,si=g.attributes.skinIndex,sw=g.attributes.skinWeight,selected=new Set<number>();
  for(let i=0;i<si.count;i++)for(let k=0;k<4;k++)if(sw.getComponent(i,k)>0&&names.has(m.skeleton.bones[si.getComponent(i,k)]?.name)){selected.add(i);break;}
  const indices=new Set<number>(),I=g.index;for(let k=0;k<(I?.count??si.count);k+=3){const tri=[0,1,2].map(j=>I?I.getX(k+j):k+j);if(tri.some(i=>selected.has(i)))tri.forEach(i=>indices.add(i));}if(indices.size)refs!.push({mesh:m,indices:[...indices]});
 });hands.set(arm,refs);return refs;
}
function solidBounds(prop:THREE.Object3D){let box=propBounds.get(prop);if(box)return box;box=new THREE.Box3();
 for(const child of [...prop.children.slice(0,4),...prop.children.filter(o=>o.name==='guitar bridge'||o.name==='guitar nut')]){const m=child as THREE.Mesh;m.updateMatrix();const p=m.geometry.attributes.position;for(let i=0;i<p.count;i++)box.expandByPoint(V().fromBufferAttribute(p,i).applyMatrix4(m.matrix));}propBounds.set(prop,box);return box;
}
/** Nearest point in the chosen configuration corridor and the actual arm workspace. */
function reachable(request:THREE.Vector3,centre:THREE.Vector3,radius:number,lo:THREE.Vector3,hi:THREE.Vector3){
 const clamp=(p:THREE.Vector3)=>p.clamp(lo,hi),closest=clamp(centre.clone());if(closest.distanceTo(centre)>radius+1e-8)return null;
 const at=(l:number)=>clamp(request.clone().addScaledVector(centre,l).multiplyScalar(1/(1+l))),r2=radius*radius;
 let out=at(0);if(out.distanceToSquared(centre)<=r2)return out;let a=0,b=1;while(at(b).distanceToSquared(centre)>r2&&b<1e12)b*=2;
 for(let k=0;k<40;k++){const m=(a+b)/2;if(at(m).distanceToSquared(centre)>r2)a=m;else b=m;}return at(b);
}

/** Guitar-specific articulation: fingers approach the string face; the forearm comes around its outer edge.
 * The contact is distal skin, not the palm or a finger bone pivot. The instrument never follows this solve. */
export function poseGuitarHand(arm:Arm,holder:THREE.Object3D,model:THREE.Object3D,contact:THREE.Vector3,fwd:THREE.Vector3,right:THREE.Vector3,weight:number,scale:number,prop:THREE.Object3D,pose:GuitarPose):GuitarHandResult{
  const failure=(code:GuitarViewerDiagnostic['code'],reason:string,target:THREE.Vector3|null=null):GuitarHandResult=>({target,diagnostic:{code,side:arm.side>0?'left':'right',reason}});
  if(weight<=0)return {target:null};
  if(arm.fingers.length!==16||arm.thumb.length!==3||!arm.thumbAxis||arm.palmLocal.lengthSq()<1e-12)
    return failure('guitar.pose.unsupported-rig','Guitar articulation requires a mapped wrist, four finger chains and thumb.');
  if(!(scale>0)||![...contact.toArray(),...fwd.toArray(),...right.toArray(),weight,scale].every(Number.isFinite))
    return failure('guitar.pose.geometry-missing','Guitar frame and contact coordinates must be finite.');
  let skinned=false,missing=false;
  model.traverse(o=>{const m=o as THREE.SkinnedMesh;if(!m.isSkinnedMesh)return;skinned=true;const g=m.geometry;
    if(!g.attributes.position||!g.attributes.skinIndex||!g.attributes.skinWeight||!m.skeleton)missing=true;});
  if(!skinned||missing||prop.children.length<4||prop.children.slice(0,4).some(o=>!(o as THREE.Mesh).geometry?.attributes.position))
    return failure('guitar.pose.geometry-missing','Guitar articulation requires rendered hand skin and four solid instrument meshes.');
  const bones=[arm.upper,arm.lower,arm.hand,...arm.fingers,...arm.thumb],before=bones.map(o=>({o,q:o.quaternion.clone(),p:o.position.clone()})),start=palm(arm,V()),startWrist=arm.hand.getWorldPosition(V()),startQ=arm.hand.getWorldQuaternion(new THREE.Quaternion());
  const restore=(code:GuitarViewerDiagnostic['code'],reason:string,target:THREE.Vector3|null=null)=>{
    for(const b of before){b.o.quaternion.copy(b.q);b.o.position.copy(b.p);}holder.updateMatrixWorld(true);
    return failure(code,reason,target);
  };
  const P=(o:THREE.Object3D)=>o.getWorldPosition(V()),fl=arm.palmLocal.clone().normalize(),f=start.clone().sub(P(arm.hand)).normalize();
  const span=P(arm.fingers[1]).sub(P(arm.fingers[13]));span.addScaledVector(f,-span.dot(f)).normalize();
  const nl=(arm.side>0?V().crossVectors(span,f):V().crossVectors(f,span)).normalize().applyQuaternion(arm.hand.getWorldQuaternion(new THREE.Quaternion()).invert()),bl=V().crossVectors(fl,nl);
  const across=right.clone().multiplyScalar(.5).add(new THREE.Vector3(0,N,0));
  const F=across.clone().multiplyScalar(arm.side>0?1:-1),normal=fwd.clone().multiplyScalar(arm.side>0?1:-1),B=V().crossVectors(F,normal);
  const q=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(F,normal,B).multiply(new THREE.Matrix4().makeBasis(fl,nl,bl).transpose()));
  if(![...q.toArray(),...nl.toArray()].every(Number.isFinite)||nl.lengthSq()<.5)
    return restore('guitar.pose.unsupported-rig','The mapped wrist and finger span cannot form an anatomical hand frame.');
  setWorldQuat(arm.hand,q);
  // Reuse the rig's mapped grip: curled fretting fingers, relaxed picking hand.
  if(arm.side>0)curlHand(arm,.65);
  else for(let finger=0;finger<4;finger++){
    const chain=arm.fingers.slice(finger*4,finger*4+4);
    const direction=P(chain[2]).sub(P(chain[1])).normalize(),axis=V().crossVectors(direction,normal).normalize();
    for(let j=1;j<4;j++)turn(chain[j],axis,[0,.5,.55,.2][j]);
  }
  if(arm.side<0){
    const thumbAxis=arm.thumbAxis.clone().applyQuaternion(arm.hand.getWorldQuaternion(new THREE.Quaternion()));
    arm.thumb.forEach((o,j)=>turn(o,thumbAxis,[.12,.35,.35][j]));
    swing(arm.thumb[0],P(arm.thumb[2]),P(arm.fingers[1]).lerp(P(arm.fingers[2]),.25).addScaledVector(normal,-.012*scale),1);
  }
  holder.updateMatrixWorld(true);
  let nearest=Infinity;const tip=V(),p=V();
  for(const r of tipSurface(arm,model))for(const i of r.indices){r.mesh.getVertexPosition(i,p).applyMatrix4(r.mesh.matrixWorld);const depth=p.dot(fwd);if(depth<nearest){nearest=depth;tip.copy(p);}}
  if(!Number.isFinite(nearest)||!wholeHand(arm,model).length)return restore('guitar.pose.geometry-missing','No mapped distal finger or whole-hand skin is available.');
  // During entry/release the hand travels on the front side before touching the strings.
  const goal=contact.clone();
  const palmGoal=palm(arm,V()).add(goal.sub(tip)),wrist=P(arm.hand),wristGoal=palmGoal.clone().sub(palm(arm,V())).add(wrist);
  const pole=fwd.clone().addScaledVector(right,arm.side>0?-.35:.7).add(new THREE.Vector3(0,.2,0));
  const S=(x:number)=>{const k=Math.max(0,Math.min(1,x));return k*k*(3-2*k);};
  const R=(x:number)=>{const k=Math.max(0,Math.min(1,x)),e=.08;return k<e?k*k/(2*e*(1-e)):k>1-e?1-(1-k)*(1-k)/(2*e*(1-e)):(k-e/2)/(1-e);};
  const H=(x:number,a:number,b:number,va:number,vb:number,da:number,db:number)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a))),t2=t*t,t3=t2*t;return (2*t3-3*t2+1)*va+(t3-2*t2+t)*(b-a)*da+(-2*t3+3*t2)*vb+(t3-t2)*(b-a)*db;};
  const leftX=(x:number)=>x<=.52?H(x,0,.52,0,.45,0,.9):H(x,.52,.9,.45,1,.9,0);
  const u=.5-Math.sin(Math.asin(Math.max(-1,Math.min(1,1-2*weight)))/3);
  const Nf=new THREE.Vector3(0,.5,0).addScaledVector(right,-N),Nn=fwd.clone().multiplyScalar(arm.side>0?1:-1),Nb=V().crossVectors(Nf,Nn);
  const narrow=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Nf,Nn,Nb).multiply(new THREE.Matrix4().makeBasis(fl,nl,bl).transpose()));
  const orient=S(u/.22),oldPlaying=S((u-.76)/.24);
  const origin=contact.clone().addScaledVector(fwd,-.058*scale),final=palmGoal.clone(),d=final.clone().sub(start);
  const oldPath=(at:number)=>{const mx=arm.side>0?leftX(at):R((at-.22)/.66),mz=R(at/(arm.side>0?.55:.58)),my=arm.side>0?mx:S((at-.4)/.5),touch=S((at-.8)/.2),edgeZ=(arm.side>0?.13:.29)*scale,nowZ=start.clone().sub(origin).dot(across),destZ=final.clone().sub(origin).dot(across);
   return start.clone().addScaledVector(fwd,(d.dot(fwd)+.028*scale)*mx-.028*scale*touch).addScaledVector(across,(edgeZ-nowZ)*mz+(destZ-edgeZ)*touch).addScaledVector(Nf,d.dot(Nf)*my);};
  const shaped=before.slice(3).map(b=>({o:b.o,q:b.o.quaternion.clone(),p:b.o.position.clone()}));
  const setShape=(orientation:THREE.Quaternion,playing:number,thumb:number)=>{setWorldQuat(arm.hand,orientation);for(let i=0;i<shaped.length;i++){const a=shaped[i],b=before[i+3],k=arm.thumb.includes(a.o)?thumb:playing;a.o.quaternion.copy(b.q).slerp(a.q,k);a.o.position.copy(b.p).lerp(a.p,k);}holder.updateMatrixWorld(true);};
  const frameOrigin=holder.position.clone().addScaledVector(fwd,pose.anchor[0]*scale).addScaledVector(right,pose.anchor[1]*scale).add(new THREE.Vector3(0,pose.anchor[2]*scale,0));
  const local=(p:THREE.Vector3)=>{const v=p.clone().sub(frameOrigin);return new THREE.Vector3(v.dot(fwd),v.dot(Nf),v.dot(across));};
  const world=(p:THREE.Vector3)=>frameOrigin.clone().addScaledVector(fwd,p.x).addScaledVector(Nf,p.y).addScaledVector(across,p.z);
  const vectorLocal=(v:THREE.Vector3)=>new THREE.Vector3(v.dot(fwd),v.dot(Nf),v.dot(across));
  const support=(orientation:THREE.Quaternion,playing:number,thumb:number)=>{setShape(orientation,playing,thumb);const pm=palm(arm,V()),box=new THREE.Box3(),p=V();for(const r of wholeHand(arm,model))for(const i of r.indices){r.mesh.getVertexPosition(i,p).applyMatrix4(r.mesh.matrixWorld).sub(pm);box.expandByPoint(vectorLocal(p));}return box;};
  const physicalLength=P(arm.upper).distanceTo(P(arm.lower))+P(arm.lower).distanceTo(P(arm.hand)),shoulder=P(arm.upper),radius=.979*physicalLength,solid=solidBounds(prop),clear=.002*scale;
  if(!(physicalLength>0)||!Number.isFinite(physicalLength)||solid.isEmpty()||!Number.isFinite(solid.min.length()+solid.max.length()))
    return restore('guitar.pose.geometry-missing','The arm workspace or instrument solid bounds are not finite.');
  let failedRequest:THREE.Vector3|null=null;
  const requestReach=(request:THREE.Vector3,centre:THREE.Vector3,lo:THREE.Vector3,hi:THREE.Vector3)=>{
    const result=reachable(request,centre,radius,lo,hi);if(!result)failedRequest=world(request);return result;
  };
  const infeasible=()=>restore('guitar.pose.corridor-infeasible','The whole-hand clearance corridor does not intersect the physical arm workspace.',failedRequest);
  const looseLo=new THREE.Vector3(-Infinity,-Infinity,-Infinity),looseHi=new THREE.Vector3(Infinity,Infinity,Infinity);
  let edge=startQ.clone().slerp(narrow,orient).slerp(q,oldPlaying),playing=oldPlaying,requestedPalm=oldPath(u);
  // Every frame uses the currently observed underlay, hand silhouette and prop frame.
  // Two deterministic solves close the incident wrist/forearm skin support after elbow placement.
  for(let iteration=0;iteration<2;iteration++){
   if(u>.22){
    const neck=prop.children[2] as THREE.Mesh;if(!neck.geometry.boundingBox)neck.geometry.computeBoundingBox();neck.updateMatrix();
    const neckEdge=neck.geometry.boundingBox!.clone().applyMatrix4(neck.matrix).min.z;
    const ns=support(narrow,0,1),fs=support(q,1,1),back=solid.min.x*scale-ns.max.x-clear,out=arm.side>0?neckEdge*scale-ns.max.z-clear:solid.max.z*scale-ns.min.z+clear,front=Math.max(solid.max.x*scale-ns.min.x+clear,solid.max.x*scale-fs.min.x+clear);
    const narrowOffset=arm.palmLocal.clone().multiply(arm.hand.getWorldScale(V())).applyQuaternion(narrow),centre=local(shoulder.clone().add(narrowOffset));
    const behindLo=looseLo.clone(),behindHi=looseHi.clone().setX(back),cornerBehindLo=arm.side>0?looseLo.clone():looseLo.clone().setZ(out),cornerBehindHi=arm.side>0?behindHi.clone().setZ(out):behindHi,cornerFrontLo=looseLo.clone().setX(front).setZ(out);
    const a=requestReach(local(oldPath(.22)),centre,behindLo,behindHi);if(!a)return infeasible();
    const b=requestReach(new THREE.Vector3(Math.min(a.x,back),a.y,out),centre,cornerBehindLo,cornerBehindHi);if(!b)return infeasible();
    const f=local(final),c=arm.side>0?requestReach(new THREE.Vector3(f.x,f.y,out),centre,looseLo,looseHi.clone().setZ(out)):requestReach(new THREE.Vector3(Math.max(f.x,front),f.y,out),centre,cornerFrontLo,looseHi);if(!c)return infeasible();
    const points=[a,b,c,f],lengths=points.slice(1).map((p,i)=>p.distanceTo(points[i])),total=lengths.reduce((a,b)=>a+b,0),travel=(u-.22)/.78*total;
    let prefix=0,index=0;for(;index<lengths.length-1;index++){if(travel<=prefix+lengths[index])break;prefix+=lengths[index];}
    const fraction=R((travel-prefix)/Math.max(1e-8,lengths[index])),approach=index===lengths.length-1?fraction:0;playing=arm.side>0?(index===0?0:index===1?fraction:1):approach;edge=narrow.clone().slerp(q,playing);requestedPalm=world(points[index].clone().lerp(points[index+1],fraction));
    const hs=support(edge,playing,1),offset=arm.palmLocal.clone().multiply(arm.hand.getWorldScale(V())).applyQuaternion(edge),currentCentre=local(shoulder.clone().add(offset)),lo=looseLo.clone(),hi=looseHi.clone();
    if(index===0)hi.x=solid.min.x*scale-hs.max.x-clear;else if(index===1){if(arm.side>0)hi.z=neckEdge*scale-hs.max.z-clear;else lo.z=solid.max.z*scale-hs.min.z+clear;}else if(arm.side<0){const front=solid.max.x*scale-hs.min.x+clear;lo.x=front+(Math.min(front,f.x)-front)*playing;}
    const attainedRequest=requestReach(local(requestedPalm),currentCentre,lo,hi);if(!attainedRequest)return infeasible();requestedPalm=world(attainedRequest);
   }else{playing=oldPlaying;edge=startQ.clone().slerp(narrow,orient).slerp(q,playing);setShape(edge,playing,Math.max(orient,playing));const offset=arm.palmLocal.clone().multiply(arm.hand.getWorldScale(V())).applyQuaternion(edge),centre=local(shoulder.clone().add(offset));const attainedRequest=requestReach(local(oldPath(u)),centre,looseLo,looseHi);if(!attainedRequest)return infeasible();requestedPalm=world(attainedRequest);}
   setShape(edge,playing,Math.max(orient,playing));wristGoal.copy(requestedPalm).sub(arm.palmLocal.clone().multiply(arm.hand.getWorldScale(V())).applyQuaternion(edge));
   const initialPole=arm.lower.getWorldPosition(V()).sub(shoulder.clone().lerp(startWrist,.5)).normalize();pole.copy(fwd).multiplyScalar(arm.side>0?-.5:1).addScaledVector(right,arm.side>0?-1.2:.8).add(new THREE.Vector3(0,arm.side>0?-.5:-.25,0)).addScaledVector(Nf,-.15);pole.lerpVectors(initialPole,pole,S(u/.35));
   ik(arm.upper,arm.lower,wrist.copy(P(arm.hand)),wristGoal,pole,1,.98);setWorldQuat(arm.hand,edge);holder.updateMatrixWorld(true);
  }
  arm.upper.updateMatrixWorld(true);
  return {target:requestedPalm};
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
