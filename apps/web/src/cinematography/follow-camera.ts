/** Experimental camera policy and bounded rendered-geometry queries. No actor or scene writes. */
import {Box3,Matrix4,Mesh,Quaternion,Ray,Vector3} from 'three';
import type {Object3D,BufferGeometry,InstancedMesh,PerspectiveCamera} from 'three';
import {cameraGroundSampler} from '../WorldCameraGround.ts';
import type {SceneInfo} from '../WorldGeometry.ts';
import type {CameraSubject} from '../../../../packages/camera/src/observation.ts';
export type PresentSubject=Extract<CameraSubject,{state:'present'}>;
export function publishedFollowGround(info:Pick<SceneInfo,'scene'|'shore'>|null){return !info||(info.scene?.surfaces.length??0)>256?undefined:cameraGroundSampler(info);}
export type Sight='clear'|'blocked'|'unknown';
export const FOLLOW_LIMITS=Object.freeze({visits:256,objects:4096,meshes:2048,depth:64,vertices:4096,triangles:12000,instances:512,candidates:7,speed:5,acceleration:5,aimSpeed:4,aimAcceleration:8});
type Scan={node:Object3D;child:number;entered:boolean};
type Bounds={position:unknown;version:number;count:number;next:number;box:Box3};
const visible=(o:Object3D)=>{let depth=0;for(let p:Object3D|null=o;p;p=p.parent){if(++depth>64||!p.visible)return false;}return true;};
/** Incremental collection over actual rendered roots. Each incomplete pass remains explicitly unknown.
 * Bounds belong to this reader; it never asks Three to compute or update shared geometry/matrices. */
export class FollowGeometry{
 private structure=new Map<Object3D,Object3D[]>();private roots:readonly Object3D[]=[];private revision='';private stack:Scan[]=[];private seen=new Set<Object3D>();private meshes:Mesh[]=[];private bounds=new WeakMap<BufferGeometry,Bounds>();private edges=0;private nextRoot=0;private failed=false;
 private ray=new Ray();private inverse=new Matrix4();private matrix=new Matrix4();private instance=new Matrix4();private a=new Vector3();private b=new Vector3();private c=new Vector3();private hit=new Vector3();
 stats={structure:0,visits:0,vertices:0,triangles:0,instances:0,queries:0,complete:false,meshes:0,unknown:null as string|null};
 reset(){this.roots=[];this.stack=[];this.seen.clear();this.structure.clear();this.meshes=[];this.bounds=new WeakMap();this.nextRoot=0;this.edges=0;this.failed=false;}
 prepare(roots:readonly Object3D[],revision:string){
  let structureChanged=false,structureWork=0;for(const [node,children]of this.structure){structureWork++;if(node.children.length!==children.length){structureChanged=true;break;}for(let i=0;i<children.length;i++){structureWork++;if(node.children[i]!==children[i]){structureChanged=true;break;}}if(structureChanged)break;}
  if(structureChanged||revision!==this.revision||roots.length!==this.roots.length||roots.some((r,i)=>r!==this.roots[i])){this.reset();this.roots=[...roots];this.revision=revision;}
  this.stats={structure:structureWork,visits:0,vertices:0,triangles:0,instances:0,queries:0,complete:false,meshes:this.meshes.length,unknown:null};
  if(!roots.length||roots.length>32||this.failed){this.stats.unknown='geometry-unavailable';return;}
  while(this.stats.visits<FOLLOW_LIMITS.visits&&(this.stack.length||this.nextRoot<this.roots.length)){
   if(!this.stack.length)this.stack.push({node:this.roots[this.nextRoot++],child:0,entered:false});
   const top=this.stack.at(-1)!;this.stats.visits++;
   if(!top.entered){top.entered=true;if(this.seen.has(top.node)){this.stack.pop();continue;}this.seen.add(top.node);if((this.edges+=top.node.children.length)>FOLLOW_LIMITS.objects){this.failed=true;break;}this.structure.set(top.node,[...top.node.children]);if(this.seen.size>FOLLOW_LIMITS.objects){this.failed=true;break;}
    const m=top.node as Mesh;if(m.isMesh&&m.userData.cameraTransparent!==true){if(this.meshes.length>=FOLLOW_LIMITS.meshes){this.failed=true;break;}this.meshes.push(m);}}
   if(top.child<top.node.children.length){if(this.stack.length>=FOLLOW_LIMITS.depth){this.failed=true;break;}this.stack.push({node:top.node.children[top.child++],child:0,entered:false});}else this.stack.pop();
  }
  // Cold geometry is admitted incrementally, with a shared vertex budget across this frame.
  let incomplete=false;
  for(const mesh of this.meshes){const g=mesh.geometry,p=g?.attributes.position;if(!p){incomplete=true;continue;}const version='version'in p?p.version:p.data.version;
   let cache=this.bounds.get(g);if(!cache||cache.position!==p||cache.version!==version||cache.count!==p.count){cache={position:p,version,count:p.count,next:0,box:new Box3()};this.bounds.set(g,cache);}
   while(cache.next<p.count&&this.stats.vertices<FOLLOW_LIMITS.vertices){this.a.fromBufferAttribute(p,cache.next++);cache.box.expandByPoint(this.a);this.stats.vertices++;}
   if(cache.next<p.count)incomplete=true;
  }
  this.stats.meshes=this.meshes.length;this.stats.complete=!this.failed&&!this.stack.length&&this.nextRoot===this.roots.length&&!incomplete;this.stats.unknown=this.stats.complete?null:this.failed?'geometry-cap':'geometry-warming';
 }
 segment(from:Vector3,to:Vector3):Sight{
  const unknown=(reason:string):Sight=>{this.stats.unknown=reason;return'unknown';};this.stats.queries++;if(!this.stats.complete)return'unknown';const length=from.distanceTo(to);if(length===0)return'clear';let invalidMatrix=false;
  for(const mesh of this.meshes){if(!visible(mesh))continue;const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];if(materials.length>64)return unknown('material-cap');if(materials.every(m=>!m.visible||m.transparent&&m.opacity<.5))continue;
   const g=mesh.geometry,bounds=this.bounds.get(g),p=g.attributes.position;if(!bounds||bounds.next<p.count)return unknown('bounds-incomplete');
   // Unsupported deformation has no proven conservative bounds. Refuse before culling.
   if((mesh as Mesh&{isSkinnedMesh?:boolean}).isSkinnedMesh||g.morphAttributes.position?.length||mesh.raycast!==Mesh.prototype.raycast&&!(mesh as InstancedMesh).isInstancedMesh)return unknown('unsupported-deformation-or-raycast');
   const instances=(mesh as InstancedMesh).isInstancedMesh?(mesh as InstancedMesh).count:1;
   for(let n=0;n<instances;n++){
    if((mesh as InstancedMesh).isInstancedMesh&&++this.stats.instances>FOLLOW_LIMITS.instances)return unknown('instance-cap');this.matrix.copy(mesh.matrixWorld);if((mesh as InstancedMesh).isInstancedMesh){(mesh as InstancedMesh).getMatrixAt(n,this.instance);this.matrix.multiply(this.instance);}
    if(!this.matrix.elements.every(Number.isFinite)||Math.abs(this.matrix.determinant())<1e-12){invalidMatrix=true;continue;}
    this.inverse.copy(this.matrix).invert();this.a.copy(from).applyMatrix4(this.inverse);this.b.copy(to).applyMatrix4(this.inverse);const localLength=this.a.distanceTo(this.b);this.ray.set(this.a,this.c.copy(this.b).sub(this.a).normalize());
    const entry=this.ray.intersectBox(bounds.box,this.hit);if(!entry||!bounds.box.containsPoint(this.ray.origin)&&entry.distanceTo(this.ray.origin)>localLength)continue;
    const ix=g.index,start=Math.max(0,g.drawRange.start),end=Math.min(ix?.count??p.count,start+g.drawRange.count);
    for(let i=start;i+2<end;i+=3){if(++this.stats.triangles>FOLLOW_LIMITS.triangles)return unknown('triangle-cap');this.a.fromBufferAttribute(p,ix?ix.getX(i):i);this.b.fromBufferAttribute(p,ix?ix.getX(i+1):i+1);this.c.fromBufferAttribute(p,ix?ix.getX(i+2):i+2);const h=this.ray.intersectTriangle(this.a,this.b,this.c,false,this.hit);if(h){const d=h.distanceTo(this.ray.origin);if(d<=localLength+1e-9*Math.max(1,localLength))return'blocked';}}
   }
  }
  return invalidMatrix?unknown('invalid-transform'):'clear';
 }
}
function approach(value:Vector3,velocity:Vector3,goal:Vector3,dt:number,speed:number,acceleration:number,tau:number){
 const desired=goal.clone().sub(value).multiplyScalar(1/tau).clampLength(0,speed),change=desired.sub(velocity).clampLength(0,acceleration*dt);velocity.add(change);value.addScaledVector(velocity,dt);
}
export type FollowResult={eye:Vector3;aim:Vector3;reason:string;candidate:number;screen:[number,number];candidates:number;motion:{groundY:number|null;sweep:Sight|null;unknown:string|null}|null};
/** Persistent world-space viewpoints let the subject turn inside a portrait dead/soft zone. */
export class FollowCamera{
 private eye=new Vector3();private aim=new Vector3();private velocity=new Vector3();private aimVelocity=new Vector3();private offset=new Vector3();private initialized=false;private clock=0;private nextSearch=0;private heldUntil=0;private gestureUntil=0;private index=0;private probe=0;
 reset(eye?:Vector3,aim?:Vector3){this.initialized=!!eye&&!!aim;if(eye&&aim){this.eye.copy(eye);this.aim.copy(aim);this.offset.copy(eye).sub(aim);}this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);this.clock=this.nextSearch=this.heldUntil=this.gestureUntil=0;this.index=0;}
 gesture(before:Vector3,after:Vector3){if(!this.initialized)return;this.offset.copy(after);this.eye.copy(this.aim).add(after);this.velocity.set(0,0,0);this.gestureUntil=this.clock+2;}
 step(subject:PresentSubject,camera:PerspectiveCamera,aim:Vector3,dt:number,geometry:FollowGeometry,ground:(x:number,z:number)=>number|null):FollowResult{
  if(!this.initialized)this.reset(camera.position,aim);dt=Math.max(0,Math.min(.05,dt));this.clock+=dt;
  const q=new Quaternion().fromArray(subject.transform.rotationXyzw),bounds=subject.bounds,root=new Vector3().fromArray(subject.transform.positionM);
  const centre=bounds?new Vector3().fromArray(bounds.min).add(new Vector3().fromArray(bounds.max)).multiplyScalar(.5).applyQuaternion(q).add(root):null;
  let motion:FollowResult['motion']=null;const result=(reason:string,screen:[number,number]=[0,0],candidates=0)=>({eye:this.eye.clone(),aim:this.aim.clone(),reason,candidate:this.index,screen,candidates,motion});
  if(!centre||!geometry.stats.complete){this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);return result(!centre?'subject-bounds-unknown':geometry.stats.unknown??'geometry-unknown');}
  const projected=centre.clone().project(camera);if(!Number.isFinite(projected.x)||!Number.isFinite(projected.y)||projected.z>1)return result('projection-unavailable');
  const screen:[number,number]=[projected.x,projected.y];
  if(this.clock<this.gestureUntil){this.eye.copy(camera.position);this.aim.copy(aim);return result('user-hold',screen);}
  const top=new Vector3(0,bounds!.max[1],0).applyQuaternion(q).add(root);
  const points=[centre,top.clone().lerp(centre,.25)];let tested=0;
  const query=(eye:Vector3):number|null=>{const y=ground(eye.x,eye.z);if(y===null||!Number.isFinite(y))return null;if(eye.y<y+1.2)return-1;let clear=0;for(const p of points){const s=geometry.segment(eye,p);if(s==='unknown')return null;clear+=s==='clear'?1:0;}return clear/points.length;};
  let reason='tracking';
  const goal=centre.clone().add(this.offset),next=this.eye.clone(),nextVelocity=this.velocity.clone();approach(next,nextVelocity,goal,dt,FOLLOW_LIMITS.speed,FOLLOW_LIMITS.acceleration,.8);
  const groundY=ground(next.x,next.z),sweep=geometry.segment(this.eye,next);motion={groundY,sweep,unknown:sweep==='unknown'?geometry.stats.unknown:null};if(groundY!==null&&Number.isFinite(groundY)&&next.y>=groundY+1.2&&sweep==='clear'){this.eye.copy(next);this.velocity.copy(nextVelocity);}else{this.velocity.set(0,0,0);reason=groundY===null||!Number.isFinite(groundY)?'ground-unavailable':next.y<groundY+1.2?'below-ground-margin':sweep==='blocked'?'motion-obstructed':'motion-unknown';}
  // Movement gets the first query budget. Probe one alternative per search tick, never
  // consume a whole candidate fan before the safety sweep has run.
  if(dt>0&&this.clock>=this.nextSearch){this.nextSearch=this.clock+.25;const angles=[Math.PI/6,-Math.PI/6,Math.PI/3,-Math.PI/3,Math.PI/2,-Math.PI/2],i=this.probe++%angles.length;
   const current=query(centre.clone().add(this.offset)),offset=this.offset.clone().applyAxisAngle(new Vector3(0,1,0),angles[i]),eye=centre.clone().add(offset);tested=2;
   const alternative=query(eye),passage=geometry.segment(this.eye,eye);
   if(current!==null&&alternative!==null&&alternative>current+.25&&passage==='clear'&&this.clock>=this.heldUntil){this.offset.copy(offset);this.index=i+1;this.heldUntil=this.clock+2;reason='viewpoint-change';}
  }
  // Framing slack comes from the current projection, not a fixed lookAt at the subject.
  const depth=Math.max(.5,centre.distanceTo(this.eye)),vertical=depth*Math.tan(camera.fov*Math.PI/360),right=new Vector3(1,0,0).applyQuaternion(camera.quaternion),up=new Vector3(0,1,0).applyQuaternion(camera.quaternion);
  const dx=projected.x-Math.max(-.14,Math.min(.14,projected.x)),dy=projected.y-Math.max(-.10,Math.min(.10,projected.y));
  const aimGoal=this.aim.clone().addScaledVector(right,dx*vertical*camera.aspect).addScaledVector(up,dy*vertical);
  approach(this.aim,this.aimVelocity,aimGoal,dt,FOLLOW_LIMITS.aimSpeed,FOLLOW_LIMITS.aimAcceleration,.3);
  if(this.eye.distanceTo(this.aim)<.5)this.aim.copy(centre); // admitted reset only; avoid a singular orientation
  return result(reason,screen,tested);
 }
}
